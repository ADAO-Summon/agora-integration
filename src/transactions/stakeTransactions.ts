import {Assets, C, Credential, Data, Datum, fromHex, DatumHash, OutputData, Lucid, PaymentKeyHash, Script, ScriptHash, toHex, UTxO, Tx, Emulator, TxComplete} from 'lucid-cardano'
import {getAuthorityPolicy, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, ScriptParams} from '../../resources/plutus.js'
import {deserializeInt, deserializeGov, deserializeProposal, deserializeStake, filterUtxosByDatum, filterUtxosByRef, getLucid, getLucidWithCredential, subAssetsFromUtxos} from '../summon-utils/util/sc.js'
import {MAKE_CREDENTIAL, MAKE_P_LOCK, MAKE_MAYBE} from '../summon-datums/agora/shared.js'
import {STAKE_DATUM, DEPOSIT_WITHDRAW_REDEEMER, DESTROY_STAKE_REDEEMER, PERMIT_VOTE_REDEEMER, UPDATE_AMOUNT_STAKE_DATUM, UPDATE_PURE_STAKE_DATUM, RETRACT_VOTE_REDEEMER, DELEGATE_TO_REDEEMER, CLEAR_DELEGATE_REDEEMER} from '../summon-datums/agora/stake.js'
import {PROPOSAL_UNLOCK_REDEEMER, PROPOSAL_VOTE_REDEEMER, PROPOSAL_COSIGN_REDEEMER, UPDATE_PROPOSAL_VOTE_DATUM, UPDATE_PROPOSAL_PURE_DATUM} from '../summon-datums/agora/proposal.js'

const createStake = async (lucid: Lucid, scriptParams: ScriptParams, amount: BigInt, readFromPolicy: UTxO | undefined, emulator: Emulator | undefined = undefined) => {
    const {ad, credential} = await getLucidWithCredential(lucid)
    let gtAsset = scriptParams.gtClassRef[0] + scriptParams.gtClassRef[1]

    let datum = ''
    try {
        datum = STAKE_DATUM(amount, credential, undefined, C.PlutusData.new_list(C.PlutusList.new()));
    } catch (e) {
        console.log(e)
        throw e
    }
        
    const assetsToStake : Assets = {'lovelace': 2000000n};
    assetsToStake[gtAsset] = BigInt(amount.toString())
    
    const stakePolicy = await getStakePolicy(scriptParams)
    const stakeValidator = await getStakeValidator(scriptParams)
    
    const stakeValidatorAddress = lucid.utils.validatorToAddress(stakeValidator)
    const stateSymbol = lucid.utils.mintingPolicyToId(stakePolicy)
    const stateName = lucid.utils.validatorToScriptHash(stakeValidator)
    const stateThread = stateSymbol + stateName
    assetsToStake[stateThread] = 1n
        
    const mintAssets : Assets = {}
    mintAssets[stateThread] = 1n
    let oData: OutputData = { inline: datum }

    let u = await lucid.utxosAt(ad)
    let us: UTxO[] = []
    u.forEach((utxo: UTxO) => {
        if (subAssetsFromUtxos(us, {})[gtAsset] || 0n < amount.valueOf()) {
            us.push(utxo)
        } else {
            console.log('skipping')
        }
    })
        
    try {
        let tx = lucid.newTx()
            .collectFrom(us)
            .payToContract(stakeValidatorAddress, oData, assetsToStake)
            .addSigner(ad)
            .mintAssets(mintAssets, Data.void())
            if (readFromPolicy) {
                tx = tx.readFrom([readFromPolicy])
            } else {
                tx = tx.attachMintingPolicy((await getStakePolicy(scriptParams)))
            }
        let txC = await tx.complete()
        return txC
    } catch (e) {
        console.log(e)
        throw e
    }
}
        
const updateStake = async (lucid: Lucid, scriptParams: ScriptParams, amount: bigint, utxo: UTxO, readFromStakeUtxo: UTxO | undefined) => {
    const {ad, credential} = await getLucidWithCredential(lucid)
    let gtAsset = scriptParams.gtClassRef[0] + scriptParams.gtClassRef[1]
    if (!utxo.datum) {
        throw "The UTxO provided has no valid datum."
    }
    
    const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(utxo.datum)
    const stakedGtNum = deserializeInt(stakedGt)
    let redeemer = ""
    try {
        let difference = BigInt(amount) - BigInt(stakedGtNum)
        redeemer = DEPOSIT_WITHDRAW_REDEEMER(BigInt(difference))
    } catch (e) {
        console.log(e)
        throw e
    }
    let afterDatum = ""
    try {
        afterDatum = UPDATE_AMOUNT_STAKE_DATUM(amount, credential, maybeDelegate, propLocks)
    } catch (e) {
        console.log(e)
        throw e
    }
    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(scriptParams)))
        
    let utxos = [utxo]
    let returnStake : Assets = subAssetsFromUtxos(utxos, {})
    returnStake[gtAsset] = BigInt(amount.toString())

    let outputData: OutputData = { inline: afterDatum }

    try {
        let tx = lucid.newTx()
            .collectFrom(utxos, redeemer)
            .payToContract(stakeValidatorAddress, outputData, returnStake)
            .addSigner(ad)
        if (readFromStakeUtxo) {
            tx = tx.readFrom([readFromStakeUtxo])
        } else {
            tx = tx.attachSpendingValidator((await getStakeValidator(scriptParams)))
        }
        let txC = await tx.complete()
        return txC
    } catch (e) {
        console.log(e)
    }
    throw ""
}

const delegateStake = async (lucid: Lucid, scriptParams: ScriptParams, stakeDatum: Datum, delegate: Credential | undefined, utxo: UTxO, readFromStakeUtxo: UTxO | undefined) => {
    const {ad} = await getLucidWithCredential(lucid)

    const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(stakeDatum)
    let redeemer = undefined
    let delegateData = undefined
    if (delegate != undefined) {
        redeemer = DELEGATE_TO_REDEEMER(delegate)
        delegateData = MAKE_MAYBE(MAKE_CREDENTIAL(delegate))
    } else {
        redeemer = CLEAR_DELEGATE_REDEEMER()
        delegateData = MAKE_MAYBE(delegate)
    }

    const afterDatum = UPDATE_PURE_STAKE_DATUM(stakedGt, ownerCred, delegateData, propLocks)
    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(scriptParams)))

    let utxos = [utxo]
    let returnStake : Assets = subAssetsFromUtxos(utxos, {})
    let outputData: OutputData = { inline: afterDatum }
        
    let tx = lucid.newTx()
        .collectFrom(utxos, redeemer)
        .payToContract(stakeValidatorAddress, outputData, returnStake)
        .addSigner(ad)
    if (readFromStakeUtxo) {
        tx = tx.readFrom([readFromStakeUtxo])
    } else {
        tx = tx.attachSpendingValidator((await getStakeValidator(scriptParams)))
    }
    let txC = await tx.complete()
    return { tx: txC, datum: afterDatum, datumHash: C.hash_plutus_data(C.PlutusData.from_bytes(fromHex(afterDatum))).to_hex() }
}
        
const destroyStake = async (lucid: Lucid, scriptParams: ScriptParams, utxos: UTxO[], readFromStakeUtxo: UTxO | undefined, readFromStakeMint: UTxO | undefined) => {
    let tx = lucid.newTx()
    for (let i = 0; i < utxos.length; i++) {
        let utxo = utxos[i]
        tx = await applyDestroyStake(lucid, tx, scriptParams, utxo, readFromStakeUtxo, readFromStakeMint)
    }
    return await tx.complete({nativeUplc: false})
}

const applyDestroyStake = async (lucid: Lucid, tx: Tx, scriptParams: ScriptParams, destroy: UTxO, readFromStakeUtxo: UTxO | undefined, readFromStakeMint: UTxO | undefined): Promise<Tx> => {
    const {ad} = await getLucidWithCredential(lucid)
    const redeemer = DESTROY_STAKE_REDEEMER()
    const stateThread = lucid.utils.validatorToScriptHash((await getStakePolicy(scriptParams))) + lucid.utils.validatorToScriptHash((await getStakeValidator(scriptParams)))
    let utxos = [destroy]
        
    const mintAssets : Assets = {}
    mintAssets[stateThread] = -1n
        
    let returnTx = tx
        .collectFrom(utxos, redeemer)
        .addSigner(ad)
        .mintAssets(mintAssets, Data.void())
    if (readFromStakeUtxo) {
        returnTx = returnTx.readFrom([readFromStakeUtxo])
    } else {
        returnTx = returnTx.attachSpendingValidator((await getStakeValidator(scriptParams)))
    }
    if (readFromStakeMint) {
        returnTx = returnTx.readFrom([readFromStakeMint])
    } else {
        returnTx = returnTx.attachMintingPolicy((await getStakePolicy(scriptParams)))
    }
    return returnTx
}

// The following functions takes two hex strings and compares them by their value.
// If a is greater than b, it returns a positive number.
const compareHex = (a: string, b: string) => {
    if (a.length != b.length) {
        return a.length - b.length
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] != b[i]) {
            return a[i].charCodeAt(0) - b[i].charCodeAt(0)
        }
    }
    return 0
}
        
const cosignProp = async (lucid: Lucid,
                        scriptParams: ScriptParams,
                        stakeDatum: Datum,
                        proposalDatum : Datum,
                        stakeUtxo: UTxO,
                        pUtxo: UTxO,
                        readFromStakeUtxo: UTxO | undefined,
                        readFromProposalUtxo: UTxO | undefined,
                        emulator: Emulator | undefined = undefined) => {
    const {ad, credential} = await getLucidWithCredential(lucid)
    const redeemer = PERMIT_VOTE_REDEEMER()
    const pRedeemer = PROPOSAL_COSIGN_REDEEMER()
    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(scriptParams)))
    const proposalValidatorAddress = lucid.utils.validatorToAddress((await getProposalValidator(scriptParams)))
    stakeUtxo.datum = stakeDatum
    pUtxo.datum = proposalDatum
    
    const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(stakeDatum)
    const {propId, effects, status, cosigners, thresholds, votes, timingConfig, startingTime} = deserializeProposal(proposalDatum)
    let idAsNum = C.BigInt.from_bytes(propId.to_bytes())

    let newLocks = C.PlutusList.new()
    let locksAsData = C.PlutusData.from_bytes(propLocks.to_bytes())
    let locksAsList = locksAsData.as_list()
    if (locksAsList == undefined) throw ""
    let lockInfo = C.PlutusList.new()
    lockInfo.add(C.PlutusData.new_integer(C.BigInt.from_str(idAsNum.to_str())))
    lockInfo.add(C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("2"), C.PlutusList.new())))
    newLocks.add(C.PlutusData.new_list(lockInfo))
    for (let i = 0; i < locksAsList.len(); i++) {
        let lock = locksAsList.get(i)
        if (lock == undefined) throw ""
        newLocks.add(lock)
    }
        
    let newCosigners = C.PlutusList.new()
    let coSignerList = C.PlutusList.from_bytes(cosigners.to_bytes())
    let coLength = coSignerList.len()

    let newCredBytes = MAKE_CREDENTIAL(credential).to_bytes()
    let inserted = false;
    for (let i = 0; i < coLength; i++) {
        let cred = coSignerList.get(i)
        let credAsBytes = cred.to_bytes()

        if (compareHex(toHex(newCredBytes), toHex(credAsBytes)) > 0) {
            newCosigners.add(C.PlutusData.from_bytes(credAsBytes))
        } else {
            if (!inserted) {
                newCosigners.add(C.PlutusData.from_bytes(newCredBytes))
                inserted = true
            }
            newCosigners.add(C.PlutusData.from_bytes(credAsBytes))
        }
    }
    if (!inserted) {
        newCosigners.add(C.PlutusData.from_bytes(newCredBytes))
    }
        
    let utxos = [stakeUtxo]
        
    let pUtxos = [pUtxo]
        
    const newPropDatum = UPDATE_PROPOSAL_PURE_DATUM(propId, effects, status, C.PlutusData.new_list(newCosigners), thresholds, votes, timingConfig, startingTime)
    const newStake = UPDATE_PURE_STAKE_DATUM(stakedGt, ownerCred, maybeDelegate, C.PlutusData.new_list(newLocks))

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

    /*
    A list of all time-sensitive redeemers and their requirements:

     - 'Agora.Proposal.Vote' can only be used when both the status is in 'Agora.Proposal.VotingReady',
       and 'Agora.Proposal.Time.isVotingPeriod' is true.
     - 'Agora.Proposal.Cosign' can only be used when both the status is in 'Agora.Proposal.Draft',
       and 'Agora.Proposal.Time.isDraftPeriod' is true.
     - 'Agora.Proposal.AdvanceProposal' can only be used when the status can be advanced
       (see 'Agora.Proposal.AdvanceProposal' docs).
     - 'Agora.Proposal.Unlock' is always valid.
    */
    const stakePay = subAssetsFromUtxos(utxos, {})
    const propPay = subAssetsFromUtxos(pUtxos, {})

    const stakeOutputDatum: OutputData = { inline: newStake }
    const propOutputDatum: OutputData = { inline: newPropDatum }
        
    // Build the Transaction
    try {
        let tx = lucid.newTx()
            .collectFrom(pUtxos, pRedeemer)
            .collectFrom(utxos, redeemer)
            .payToContract(proposalValidatorAddress, propOutputDatum, propPay)
            .payToContract(stakeValidatorAddress, stakeOutputDatum, stakePay)
            .validFrom(nowNum)
            .validTo(afterNum)
            .addSigner(ad)
            if (readFromProposalUtxo) {
                tx = tx.readFrom([readFromProposalUtxo])
            } else {
                tx = tx.attachMintingPolicy((await getProposalValidator(scriptParams)))
            }
            if (readFromStakeUtxo) {
                tx = tx.readFrom([readFromStakeUtxo])
            } else {
                tx = tx.attachSpendingValidator(await getStakeValidator(scriptParams))
            }
            let txC: TxComplete;
            if (!emulator) {
                txC = await tx.complete({nativeUplc: false})
            } else {
                txC = await tx.complete()
            }
        return { tx: txC }
    } catch (e) {
        console.log(e)
        throw e
    }
}

const permitVote = async (
        lucid: Lucid,
        scriptParams: ScriptParams,
        utxos: UTxO[],
        pUtxo: UTxO,
        result: BigInt,
        readFromStakeUtxo: UTxO | undefined,
        readFromProposalUtxo: UTxO | undefined,
        emulator: Emulator | undefined = undefined
    ) => {
    if (!pUtxo.datum) throw "Proposal has no datum"
    const {ad} = await getLucidWithCredential(lucid)
    const pRedeemer = PROPOSAL_VOTE_REDEEMER(result)
    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(scriptParams)))
    const proposalValidatorAddress = lucid.utils.validatorToAddress((await getProposalValidator(scriptParams)))
    let gtAsset = scriptParams.gtClassRef[0] + scriptParams.gtClassRef[1]
    
    const {propId, effects, status, cosigners, thresholds, votes, timingConfig, startingTime} = deserializeProposal(pUtxo.datum)
    let newId = deserializeInt(propId)

    const redeemer = PERMIT_VOTE_REDEEMER()

    let votesAsMap = C.PlutusMap.from_bytes(votes?.to_bytes())
    let calculatedVotes : Map<BigInt, BigInt> = new Map()
    let voteChoices = votesAsMap.keys()
    let numVoteChoices = voteChoices.len()
    for (let i = 0; i < numVoteChoices; i++) {
        let choice = voteChoices.get(i)
        let intChoice = C.BigInt.from_bytes(choice.to_bytes())
        let numChoice = Number(intChoice.to_str())
        let va = votesAsMap.get(choice)
        if (va == undefined) throw "va should not be undefined"
        let intVa = C.BigInt.from_bytes(va.to_bytes())
        let numVa = Number(intVa.to_str())
        if (result == BigInt(numChoice)) {
            numVa = numVa + Number(subAssetsFromUtxos(utxos, {})[gtAsset].toString())
        }
        calculatedVotes.set(BigInt(numChoice), BigInt(numVa))
    }
    let now
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

    let newPropLock = C.PlutusList.new()
    let lockList = C.PlutusList.new()
    lockList.add(C.PlutusData.new_integer(C.BigInt.from_str(result.toString())))
    lockList.add(C.PlutusData.new_integer(C.BigInt.from_str(afterNum.toString())))
    newPropLock.add(C.PlutusData.new_integer(C.BigInt.from_str(newId.toString())))
    newPropLock.add(C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("1"), lockList)))

    let pUtxos = [pUtxo]
    try {
        const newPropDatum = UPDATE_PROPOSAL_VOTE_DATUM(propId, effects, status, cosigners, thresholds, calculatedVotes, timingConfig, startingTime)
        const newPropOutputData: OutputData = { inline: newPropDatum }

        // Build the Transaction
        let tx = lucid.newTx()
            .collectFrom(pUtxos, pRedeemer)
            .collectFrom(utxos, redeemer)
            .payToContract(proposalValidatorAddress, newPropOutputData, subAssetsFromUtxos(pUtxos, {}))
            .validFrom(nowNum)
            .validTo(afterNum)
            .addSigner(ad)
            if (readFromProposalUtxo) {
                tx = tx.readFrom([readFromProposalUtxo])
            } else {
                tx = tx.attachMintingPolicy((await getProposalValidator(scriptParams)))
            }
            if (readFromStakeUtxo) {
                tx = tx.readFrom([readFromStakeUtxo])
            } else {
                tx = tx.attachSpendingValidator(await getStakeValidator(scriptParams))
            }

        for (let i = 0; i < utxos.length; i++) {
            const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(utxos[i].datum || "")
            const locksAsList = propLocks.as_list()
            if (!locksAsList) throw new Error("Invalid Stake Datum")
        
            let propLockList = C.PlutusList.new();
            try {
                propLockList.add(C.PlutusData.new_list(newPropLock))
                for (let i = 0; i < locksAsList.len(); i++) {
                    let lock = locksAsList.get(i)
                    if (lock == undefined) throw ""
                    propLockList.add(C.PlutusData.from_bytes(lock.to_bytes()))
                }
            } catch (e) {
                console.log(e)
                throw e
            }
            const newStakeDatum = UPDATE_PURE_STAKE_DATUM(stakedGt, ownerCred, maybeDelegate, C.PlutusData.new_list(propLockList))
            tx = tx.payToContract(stakeValidatorAddress, {inline: newStakeDatum}, utxos[i].assets)
        }
        let txC: TxComplete;
        if (!emulator) {
            txC = await tx.complete({nativeUplc: false})
        } else {
            txC = await tx.complete()
        }

        return { tx: txC }
    } catch (e) {
        console.log(e)
        throw e
    }
}

export const unlockVote = async (lucid: Lucid, scriptParams: ScriptParams, utxos: UTxO[], pUtxo: UTxO, readFromStakeUtxo: UTxO | undefined, readFromProposalUtxo: UTxO | undefined, emulator: Emulator | undefined = undefined) => {
    const pRedeemer = PROPOSAL_UNLOCK_REDEEMER()
    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(scriptParams)))
    const proposalValidatorAddress = lucid.utils.validatorToAddress((await getProposalValidator(scriptParams)))
    let gtAsset = scriptParams.gtClassRef[0] + scriptParams.gtClassRef[1]

    let now: number = 0;
    if (!emulator) {
        let d = new Date()
        now = d.valueOf()
    } else {
        now = emulator.now()
    }
    const currentSlot = lucid.utils.unixTimeToSlot(now) - 100
    const afterSlot = currentSlot + 500
    const nowNum: number = lucid.utils.slotToUnixTime(currentSlot)
    const afterNum: number = lucid.utils.slotToUnixTime(afterSlot)
    
    const {propId, status} = deserializeProposal(pUtxo.datum || "")
    let newId = deserializeInt(propId)
    const redeemer = RETRACT_VOTE_REDEEMER()

    let pUtxos = [pUtxo]
        
    // Build the Transaction
    let tx = lucid.newTx()
        .collectFrom(utxos, redeemer)
        .collectFrom(pUtxos, pRedeemer)
        .addSigner(await lucid.wallet.address()) // TODO - This is not adequate for MultiAddressUsers, or is it?
        .validFrom(nowNum)
        .validTo(afterNum)
    
    if (readFromProposalUtxo) {
        tx = tx.readFrom([readFromProposalUtxo])
    } else {
        tx = tx.attachSpendingValidator((await getProposalValidator(scriptParams)))
    }
    if (readFromStakeUtxo) {
        tx = tx.readFrom([readFromStakeUtxo])
    } else {
        tx = tx.attachSpendingValidator((await getStakeValidator(scriptParams)))
    }

    for (let i = 0; i < utxos.length; i++) {
        const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(utxos[i].datum || "")
        let newPropLocks = C.PlutusList.new()
        let propLockList = C.PlutusList.from_bytes(propLocks.to_bytes())
        let propLength = propLockList.len()
        for (let i = 0; i < propLength; i++) {
            let lock = propLockList.get(i).as_list()
            if (!lock) throw "Iterating through the propLockList failed in retractVote."
            if (deserializeInt(lock.get(0)) != newId) {
                if ((deserializeInt(lock.get(1).as_constr_plutus_data()?.alternative()) != "1") && (deserializeInt(status) != "3")) {
                    throw "The proposal must be finished to unlock this UTxO."
                } else {
                    newPropLocks.add(propLockList.get(i))
                }
            }
        }
        const newStakeDatum = UPDATE_PURE_STAKE_DATUM(stakedGt, ownerCred, maybeDelegate, C.PlutusData.new_list(newPropLocks))
        tx = tx.payToContract(stakeValidatorAddress, { inline: newStakeDatum }, utxos[i].assets)
    }
    tx = tx.payToContract(proposalValidatorAddress, { inline: pUtxo.datum || "" }, pUtxo.assets)

    let txC = await tx.complete()
    return { tx: txC }
}
        
const retractVote = async (lucid: Lucid, scriptParams: ScriptParams, utxos: UTxO[], pUtxo: UTxO, readFromStakeUtxo: UTxO | undefined, readFromProposalUtxo: UTxO | undefined, emulator: Emulator | undefined = undefined) => {
    const pRedeemer = PROPOSAL_UNLOCK_REDEEMER()
    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(scriptParams)))
    const proposalValidatorAddress = lucid.utils.validatorToAddress((await getProposalValidator(scriptParams)))
    let gtAsset = scriptParams.gtClassRef[0] + scriptParams.gtClassRef[1]
        
    const {propId, effects, status, cosigners, thresholds, votes, timingConfig, startingTime} = deserializeProposal(pUtxo.datum || "")
    let newId = deserializeInt(propId)
    const redeemer = RETRACT_VOTE_REDEEMER()

    let now: number = 0;
    if (!emulator) {
        let d = new Date()
        now = d.valueOf()
    } else {
        now = emulator.now()
    }
    const currentSlot = lucid.utils.unixTimeToSlot(now) - 10
    const afterSlot = currentSlot + 50
    const nowNum: number = lucid.utils.slotToUnixTime(currentSlot)
    const afterNum: number = lucid.utils.slotToUnixTime(afterSlot)

    let pUtxos = [pUtxo]
        
    // Build the Transaction
    let tx = lucid.newTx()
        .collectFrom(utxos, redeemer)
        .collectFrom(pUtxos, pRedeemer)
        .addSigner(await lucid.wallet.address())
        .validFrom(nowNum)
        .validTo(afterNum)
    
    if (readFromProposalUtxo) {
        tx = tx.readFrom([readFromProposalUtxo])
    } else {
        tx = tx.attachSpendingValidator((await getProposalValidator(scriptParams)))
    }
    if (readFromStakeUtxo) {
        tx = tx.readFrom([readFromStakeUtxo])
    } else {
        tx = tx.attachSpendingValidator((await getStakeValidator(scriptParams)))
    }

    let votesAsMap = C.PlutusMap.from_bytes(votes?.to_bytes())
    let calculatedVotes : Map<BigInt, BigInt> = new Map()
    let voteChoices = votesAsMap.keys()
    let numVoteChoices = voteChoices.len()
    for (let i = 0; i < utxos.length; i++) {
        const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(utxos[i].datum || "")
        let newPropLocks = C.PlutusList.new()
        let propLockList = C.PlutusList.from_bytes(propLocks.to_bytes())
        let propLength = propLockList.len()
        let result;
        for (let i = 0; i < propLength; i++) {
            let lock = propLockList.get(i).as_list()
            if (!lock) throw "Iterating through the propLockList failed in retractVote."
            if (deserializeInt(lock.get(0)) != newId) {
                if (deserializeInt(lock.get(1).as_constr_plutus_data()?.alternative()) == "1") {
                    newPropLocks.add(propLockList.get(i))
                } else {
                    throw "The proposal must be finished to unlock this UTxO."
                }
            }
        }
        for (let i = 0; i < numVoteChoices; i++) {
            let choice = voteChoices.get(i)
            let intChoice = C.BigInt.from_bytes(choice.to_bytes())
            let numChoice = Number(intChoice.to_str())
            let va = votesAsMap.get(choice)
            if (va == undefined) throw "wtf"
            let intVa = C.BigInt.from_bytes(va.to_bytes())
            let numVa = Number(intVa.to_str())
            if (result == BigInt(numChoice)) {
                numVa = numVa - Number(subAssetsFromUtxos(utxos, {})[gtAsset].toString())
            }
            calculatedVotes.set(BigInt(numChoice), BigInt(numVa))
        }
        const newStakeDatum = UPDATE_PURE_STAKE_DATUM(stakedGt, ownerCred, maybeDelegate, C.PlutusData.new_list(newPropLocks))
        tx = tx.payToContract(stakeValidatorAddress, { inline: newStakeDatum }, utxos[i].assets)
    }
    const newPropDatum = UPDATE_PROPOSAL_VOTE_DATUM(propId, effects, status, cosigners, thresholds, calculatedVotes, timingConfig, startingTime)
    tx = tx.payToContract(proposalValidatorAddress, { inline: newPropDatum }, pUtxo.assets)
    let txC = await tx.complete()
    return { tx: txC }
}

export {
    cosignProp,
    createStake,
    delegateStake,
    destroyStake,
    permitVote,
    retractVote,
    updateStake
};