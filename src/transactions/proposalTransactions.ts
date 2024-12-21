import { PrismaClient } from '@prisma/client'
import {Assets, C, Data, Datum, fromHex, DatumHash, OutputData, Lucid, PaymentKeyHash, Script, ScriptHash, toHex, UTxO, Emulator, Tx, TxComplete} from 'lucid-cardano'
import {getAuthorityPolicy, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, ScriptParams} from '../../resources/plutus.js'
import {deserializeInt, deserializeGov, deserializeProposal, deserializeStake, deserializeEffects, deserializeVotes, filterUtxosByRef, getLucid, getLucidWithCredential, gtAsset, subAssetsFromUtxos} from '../summon-utils/util/sc.js'
import {STAKE_DATUM, PERMIT_VOTE_REDEEMER, UPDATE_AMOUNT_STAKE_DATUM, UPDATE_PURE_STAKE_DATUM} from '../summon-datums/agora/stake.js'
import {PROPOSAL_ADVANCE_REDEEMER, PROPOSAL_DATUM, UPDATE_PROPOSAL_PURE_DATUM} from '../summon-datums/agora/proposal.js'
import {MINT_GAT_REDEEMER, CREATE_PROPOSAL_REDEEMER, UPDATED_GOVERNOR} from '../summon-datums/agora/governor.js'
import { gunzip } from 'zlib'
import { handleTimingConfig } from '../txEndpoints/proposalEndpoints.js'

type NewProposal = {
    effects: Map<BigInt, Map<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]>>,
    votes: Map<BigInt, BigInt>
}

const createProposal = async (lucid: Lucid,
                            scriptParams: ScriptParams,
                            sUtxo: UTxO,
                            stakeDatum: Datum,
                            gTxo: UTxO,
                            governorDatum: Datum,
                            proposal: NewProposal,
                            readFromStakeUtxo: UTxO | undefined,
                            readFromProposalPolicyUtxo: UTxO | undefined,
                            readFromGovernorUtxo: UTxO | undefined,
                            emulator: Emulator | undefined = undefined
) => {
    const {ad, credential} = await getLucidWithCredential(lucid)

    const gRedeemer = CREATE_PROPOSAL_REDEEMER()
    const stakeValidator = await getStakeValidator(scriptParams)
    const proposalValidator = await getProposalValidator(scriptParams)
    const governorValidator = await getGovernorValidator(scriptParams)
    const stakeValidatorAddress = lucid.utils.validatorToAddress(stakeValidator)
    const proposalValidatorAddress = lucid.utils.validatorToAddress(proposalValidator)
    const governorValidatorAddress = lucid.utils.validatorToAddress(governorValidator)

    let now;
    if (!emulator) {
        let d = new Date()
        now = d.valueOf()
    } else {
        now = emulator.now()
    }
    const currentSlot = lucid.utils.unixTimeToSlot(now) - 100
    const afterSlot = currentSlot + 500
    const nowNum = lucid.utils.slotToUnixTime(currentSlot)
    const afterNum = lucid.utils.slotToUnixTime(afterSlot)

    const before = nowNum
    const after = afterNum

    const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(stakeDatum)
    const {propThresholds, nextPropId, timingConfig, maxTimeRange, maxProposalsPerStake} = deserializeGov(governorDatum)

    let idAsNum = C.BigInt.from_bytes(nextPropId.to_bytes())
    if (idAsNum == undefined) throw "nextPropId is not an int"
    let newId = Number(idAsNum.to_str()) + 1

    const redeemer = PERMIT_VOTE_REDEEMER()

    let newLocks = C.PlutusList.new()
    let locksAsData = C.PlutusData.from_bytes(propLocks.to_bytes())
    let locksAsList = locksAsData.as_list()
    if (locksAsList == undefined) throw ""
    let lockInfo = C.PlutusList.new()
    lockInfo.add(C.PlutusData.new_integer(C.BigInt.from_str(idAsNum.to_str())))
    lockInfo.add(C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("0"), C.PlutusList.new())))
    newLocks.add(C.PlutusData.new_list(lockInfo)) // C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("0"), lockInfo)))
    for (let i = 0; i < locksAsList.len(); i++) {
        let lock = locksAsList.get(i)
        if (lock == undefined) throw ""
        newLocks.add(lock)
    }

    let maxAsNum = C.BigInt.from_bytes(maxTimeRange.to_bytes())
    if (maxAsNum == undefined) throw "Max Range is undefined"

    const propDatum = PROPOSAL_DATUM(
        nextPropId,
        proposal.effects,
        0n,
        [credential],
        propThresholds,
        proposal.votes,
        timingConfig,
        new Date((before + after)/2)
    )

    const newGov = UPDATED_GOVERNOR(propThresholds, newId, timingConfig, maxTimeRange, maxProposalsPerStake)
    const newStake = UPDATE_PURE_STAKE_DATUM(stakedGt, ownerCred, maybeDelegate, C.PlutusData.new_list(newLocks))

    const proposalPolicy = await getProposalPolicy(scriptParams)
    const stateThread = lucid.utils.validatorToScriptHash(proposalPolicy)

    let proposalPay : Assets = {}
    proposalPay['lovelace'] = 2000000n;
    proposalPay[stateThread] = 1n;

    let mintAssets : Assets = {}
    mintAssets[stateThread] = 1n;

    // Get User UTxOs
    let utxos = [sUtxo]

    // Get Governor UTxO
    let gUtxos = [gTxo]

    const propOutputData: OutputData = {inline: propDatum}
    const stakeOutputData: OutputData = {inline: newStake}
    
    // Build the Transaction
    let tx = lucid.newTx()
        .collectFrom(utxos, redeemer)
        .collectFrom(gUtxos, gRedeemer)
        .mintAssets(mintAssets, Data.void())
    tx = tx.payToContract(proposalValidatorAddress, propOutputData, proposalPay)
        .payToContract(stakeValidatorAddress, stakeOutputData, subAssetsFromUtxos(utxos, {}))
        .payToContract(governorValidatorAddress, {inline: newGov}, subAssetsFromUtxos(gUtxos, {}))
        .validFrom(before)
        .validTo(after)
        .addSigner(ad)
        if (readFromStakeUtxo) {
            if (readFromStakeUtxo.scriptRef) console.log("Referencing Stake Validator", lucid.utils.validatorToScriptHash(readFromStakeUtxo.scriptRef))
            tx = tx.readFrom([readFromStakeUtxo])
        } else {
            tx = tx.attachSpendingValidator(stakeValidator)
        }
        if (readFromGovernorUtxo) {
            if (readFromGovernorUtxo.scriptRef) console.log("Referencing Governor Validator", lucid.utils.validatorToScriptHash(readFromGovernorUtxo.scriptRef))
            tx = tx.readFrom([readFromGovernorUtxo])
        } else {
            tx = tx.attachSpendingValidator(governorValidator)
        }
        tx = tx.attachMintingPolicy(proposalPolicy)
        if (readFromProposalPolicyUtxo) {
            console.log("Referencing Proposal Policy")
            tx = tx.readFrom([readFromProposalPolicyUtxo])
        } else {
            tx = tx.attachMintingPolicy(proposalPolicy)
        }
    try {
        let txComplete;
        if (emulator) {
            txComplete = await tx.complete({nativeUplc: true})
        } else {
            txComplete = await tx.complete({nativeUplc: false})
        }
        if (!txComplete) throw "Transaction failed to complete."
        let propId = nextPropId.as_integer()?.to_str() || ""
        if (propId == "") throw "Proposal id is not valid."

        return { tx: txComplete, proposalId: Number(propId), stakeDatum: stakeDatum,
            stakeDHash: C.hash_plutus_data(C.PlutusData.from_bytes(fromHex(newStake))).to_hex(),
            govDatum: newGov, govDHash: C.hash_plutus_data(C.PlutusData.from_bytes(fromHex(newGov))).to_hex(),
            propDatum: propDatum, propDHash: C.hash_plutus_data(C.PlutusData.from_bytes(fromHex(propDatum))).to_hex() }
    } catch (e) {
        console.log(e)
        throw e
    }
}

// utility function to determine whether or not the proposal can be advanced based on current time.
const canAdvanceProposal = (now: number, draftTime: number, votingTime: number, lockTime: number, executeTime: number, startingTime: number, status: number) => {
    if (status == 3) return false
    if (status == 0 && now > startingTime + draftTime) return false
    if (status == 1 && now > startingTime + draftTime + votingTime + lockTime) return false
    if (status == 2 && now > startingTime + draftTime + votingTime + lockTime + executeTime) return false
    return true
}

const handleLocked = async (
    lucid: Lucid,
    statusInt: number,
    scriptParams: ScriptParams,
    gUtxo: UTxO,
    tx: Tx,
    readFromGovernorUtxo: UTxO[] | undefined,
    governorValidatorAddress: string,
    votes: any,
    effectScripts: any
) => {
    const inLock = statusInt == 2
    if (inLock) {
        const gRedeemer = MINT_GAT_REDEEMER()
        const effectPolicy = await getAuthorityPolicy(scriptParams)
        let gUtxos = [gUtxo]
        if (!gUtxo.datum) throw "No datum on governor utxo"

        tx = tx.collectFrom(gUtxos, gRedeemer)
            .payToContract(governorValidatorAddress, {inline: gUtxo.datum}, gUtxo.assets)
        if (readFromGovernorUtxo) {
            tx = tx.readFrom(readFromGovernorUtxo)
        } else {
            tx = tx.attachSpendingValidator((await getGovernorValidator(scriptParams)))
        }

        let deserializedVotes: Map<BigInt, BigInt> = deserializeVotes(votes)
        let max = BigInt(0)
        let result;
        for (let key of deserializedVotes) {
            if (max < key[1].valueOf()) {
                max = BigInt(key[1].toString())
                result = BigInt(key[0].toString())
            }
        }
        if (result == undefined) throw "There is no valid outcome for the proposal."

        let effectsMap = effectScripts.get(result)
        if (effectsMap == undefined) throw "Trouble with getting the 'winning' effects from the proposal."
        let minting = false;
        for (let scriptPair of effectsMap) {
            minting = true
            let newGats: Assets = {}
            let effectAddress = lucid.utils.validatorToAddress(scriptPair[0])
            let effectDatum = scriptPair[1][0]
            let effectAsset = lucid.utils.mintingPolicyToId(effectPolicy)
            let effectPaid: Assets = {}
            effectPaid['lovelace'] = 2000000n
            effectPaid[effectAsset] = 1n
            newGats[effectAsset] = newGats[effectAsset] ? BigInt(newGats[effectAsset].toString()) + 1n : 1n

            tx = tx.payToContract(effectAddress, {inline: effectDatum}, effectPaid)
                .mintAssets(newGats, Data.void())
        }
        if (minting) {
            tx = tx.attachMintingPolicy(effectPolicy)
        }
    }
    return tx
}

const advanceProposal = async (lucid: Lucid,
    scriptParams: ScriptParams,
    pUtxo: UTxO,
    proposal: Datum,
    gUtxo: UTxO,
    governorDatum: Datum,
    effectScripts: Map<BigInt, Map<Script, [arg0: Datum, arg1: Script | undefined]>>,
    witnessStakes: UTxO[] | undefined,
    readFromProposalUtxo: UTxO[] | undefined,
    readFromGovernorUtxo: UTxO[] | undefined,
    emulator: Emulator | undefined = undefined
) => {
    try {
        let now;
        if (!emulator) {
            let d = new Date()
            now = d.valueOf()
        } else {
            now = emulator.now()
        }
        const {propId, effects, status, cosigners, thresholds, votes, timingConfig, startingTime} = deserializeProposal(proposal)
        const draftTime = Number(deserializeInt(timingConfig.as_list()?.get(0)))
        const votingTime = Number(deserializeInt(timingConfig.as_list()?.get(1)))
        const lockTime = Number(deserializeInt(timingConfig.as_list()?.get(2)))
        const executeTime = Number(deserializeInt(timingConfig.as_list()?.get(3)))
        const minStakeLocked = Number(deserializeInt(timingConfig.as_list()?.get(4)))
        const votingTimeWidth = Number(deserializeInt(timingConfig.as_list()?.get(5)))
        const start = Number(deserializeInt(startingTime))
        const statusInt = Number(deserializeInt(status))
        if (statusInt == 3) throw "We cannot advance the proposal once it's finished."
        let newStatusInt = statusInt + 1
        if (!canAdvanceProposal(now, draftTime, votingTime, lockTime, executeTime, start, statusInt)) {
            newStatusInt = 3
        }
        const newStatus = C.PlutusData.new_integer(C.BigInt.from_str(newStatusInt.toString()))

        const currentSlot = lucid.utils.unixTimeToSlot(now) - 20
        const afterSlot = currentSlot + 80

        const nowNum = lucid.utils.slotToUnixTime(currentSlot)
        const afterNum = lucid.utils.slotToUnixTime(afterSlot)

        const governorValidatorAddress = lucid.utils.validatorToAddress((await getGovernorValidator(scriptParams)))
        const proposalValidatorAddress = lucid.utils.validatorToAddress((await getProposalValidator(scriptParams)))

        const newProposalDatum = UPDATE_PROPOSAL_PURE_DATUM(propId, effects, newStatus, cosigners, thresholds, votes, timingConfig, startingTime)

        let pUtxos = [pUtxo]
        if (!pUtxo.datum) throw "No datum on the proposal utxo"
        let pOutputData: OutputData = {inline: newProposalDatum}

        let tx = lucid.newTx()
        if (statusInt == 0) {
            if (witnessStakes == undefined) {
                throw ""
            }
            tx = tx.readFrom(witnessStakes)
        }

        tx = tx.payToContract(proposalValidatorAddress, pOutputData, pUtxo.assets)
            .collectFrom(pUtxos, PROPOSAL_ADVANCE_REDEEMER())
            .validFrom(nowNum)
            .validTo(afterNum)
        if (readFromProposalUtxo) {
            tx = tx.readFrom(readFromProposalUtxo)
        } else {
            tx = tx.attachSpendingValidator((await getProposalValidator(scriptParams)))
        }
        let innerMeta: any = {}

        tx = await handleLocked(lucid, statusInt, scriptParams, gUtxo, tx, readFromGovernorUtxo, governorValidatorAddress, votes, effectScripts)

        let txComplete: TxComplete;
        if (!emulator) {
            txComplete = await tx.complete({nativeUplc: false})
        } else {
            txComplete = await tx.complete()
        }
        return {tx: txComplete}
    } catch (e) {
        throw e
    }
}

export {advanceProposal,
    createProposal
};