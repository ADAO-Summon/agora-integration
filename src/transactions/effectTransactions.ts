import {Address, Assets, C, Data, Datum, fromHex, DatumHash, OutputData, Lucid, PaymentKeyHash, Script, ScriptHash, toHex, UTxO, Emulator, Tx} from 'lucid-cardano'
import {getAuthorityPolicy, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, getTreasuryValidator, mutateGovernor, ScriptParams, spendFromTreasury} from '../../resources/plutus.js'
import {deserializeGov, deserializeProposal, deserializeEffects, deserializeVotes, deserializeStake, filterUtxosByRef, getLucid, getLucidWithCredential, gtAsset, subAssetsFromUtxos, addAssets} from '../summon-utils/util/sc.js'
import {STAKE_DATUM, PERMIT_VOTE_REDEEMER, UPDATE_AMOUNT_STAKE_DATUM} from '../summon-datums/agora/stake.js'
import {PROPOSAL_ADVANCE_REDEEMER, PROPOSAL_DATUM, UPDATE_PROPOSAL_PURE_DATUM} from '../summon-datums/agora/proposal.js'
import {MINT_GAT_REDEEMER, CREATE_PROPOSAL_REDEEMER, UPDATED_GOVERNOR, GOVERNOR_UPDATE_DATUM, GOVERNOR_DATUM, MUTATE_GOVERNOR_REDEEMER} from '../summon-datums/agora/governor.js'

export type GovernorEffect = {
    thresholds: [BigInt, BigInt, BigInt, BigInt, BigInt],
    propId: BigInt,
    propTimings: [Date, Date, Date, Date, Date, Date],
    newProposalValidLength: Date,
    proposalsPerStake: BigInt,
    newThresholds: [BigInt, BigInt, BigInt, BigInt, BigInt],
    newPropTimings: [Date, Date, Date, Date, Date, Date],
    newNewProposalValidLength: Date,
    newProposalsPerStake: BigInt
}

const createOutputsFromSpendDatum = async (lucid: Lucid, tx: Tx, data: {receivers: [arg0: Address, arg1: Assets, arg2: OutputData | undefined][], treasuries: Address[]}): Promise<Tx> => {
    try {
        for (const receiver of data.receivers) {
            let address = receiver[0];
            let assets = receiver[1];
            if (receiver[2]) {
                tx = tx.payToAddressWithData(address, receiver[2], assets)
            } else {
                tx = tx.payToAddress(address, assets)
            }
        }
        return tx
    } catch (e) {
        console.log(e)
    }
    throw new Error("Failed to create outputs from spend datum")
}

const getCompiledAssets = (data: {receivers: [arg0: Address, arg1: Assets, arg2: OutputData | undefined][], treasuries: Address[]}) => {
    let assets: Assets = {}
    for (const receiver of data.receivers) {
        if (!receiver) throw "Receiver is undefined"
        if (!receiver[1]) throw "Receiver assets are undefined"
        assets = addAssets(assets, receiver[1])
    }
    return assets
}

export const spendFromTreasuryTx = async (lucid: Lucid, scriptParams: ScriptParams, effectUtxo: UTxO, effectData: {receivers: [arg0: Address, arg1: Assets, arg2: OutputData | undefined][], treasuries: Address[]}, treasuryReference: UTxO | undefined, effectReference: UTxO | undefined) => {
    try {
        let tScript = await getTreasuryValidator(scriptParams)
        let utxos: UTxO[] = []
        for (const treasury of effectData.treasuries) {
            let u = await lucid.utxosAt(treasury)
            utxos = utxos.concat(u)
        }
        let tx = lucid.newTx()
                .collectFrom(utxos, Data.void())
                .attachSpendingValidator(tScript)
                .collectFrom([effectUtxo], Data.void())
                .attachSpendingValidator(await spendFromTreasury(scriptParams))
        tx = await createOutputsFromSpendDatum(lucid, tx, effectData)
        tx = tx.payToContract(lucid.utils.validatorToAddress(tScript), Data.void(), subAssetsFromUtxos(utxos, getCompiledAssets(effectData)))

        let effectPolicy = await getAuthorityPolicy(scriptParams)
        tx = tx.mintAssets({[lucid.utils.mintingPolicyToId(effectPolicy)]: -1n}, Data.void())
                .attachMintingPolicy(effectPolicy)
        
        return {tx: await tx.complete()}
    } catch (e) {
        console.log(e)
    }
}

export const mutateGovernorTx = async (lucid: Lucid, scriptParams: ScriptParams, effectUtxo: UTxO, effectData: GovernorEffect, governorUtxo: UTxO, readFromGovernorUtxo: UTxO | undefined) => {
    try {
        let governorScript = await getGovernorValidator(scriptParams)
        let governorEffect = await mutateGovernor(scriptParams)

        let newGovernorDatum = GOVERNOR_DATUM(effectData.newThresholds, effectData.propId, effectData.newPropTimings, effectData.newNewProposalValidLength, effectData.newProposalsPerStake)

        let tx = lucid.newTx()
                .collectFrom([governorUtxo], MUTATE_GOVERNOR_REDEEMER())
                .attachSpendingValidator(governorEffect)
                .collectFrom([effectUtxo], Data.void())
                if (readFromGovernorUtxo) {
                    tx = tx.readFrom([readFromGovernorUtxo])
                } else {
                    tx = tx.attachSpendingValidator(governorScript)
                }
                tx = tx.payToContract(lucid.utils.validatorToAddress(governorScript), { inline: newGovernorDatum }, subAssetsFromUtxos([governorUtxo], {}))

        let effectPolicy = await getAuthorityPolicy(scriptParams)
        tx = tx.mintAssets({[lucid.utils.mintingPolicyToId(effectPolicy)]: -1n}, Data.void())
                .attachMintingPolicy(effectPolicy)
        
        return {tx: await tx.complete()}
    } catch (e) {
        console.log(e)
    }
}