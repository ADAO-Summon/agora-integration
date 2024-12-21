import { PrismaClient } from '@prisma/client';
import { getGovernorPolicy, getGovernorValidator } from '../../resources/plutus.js'
import { spendFromTreasuryTx, mutateGovernorTx, GovernorEffect } from '../transactions/effectTransactions.js';
import { deserializeGov, deserializeInt, getLucid } from '../summon-utils/util/sc.js'
import { getScriptParamsForCommunity } from './daoSelection.js'
import { Assets, C, OutRef, OutputData, fromHex, toHex } from 'lucid-cardano';
import { convertAssetsStringToAssets } from './proposalEndpoints.js';

type SpendFromTreasuryBody = {
    communityId: string,
    address: string, // User address
    effectUtxo: OutRef,
    receivers: [string, Record<string, string>, OutputData | undefined][], // Address, Assets
    treasuries: string[], // Treasury addresses
    utxos: OutRef[]
}

type UpdateGovernorBody = {
    communityId: string,
    address: string, // User address
    effectUtxo: OutRef,
    utxos: OutRef[]
}

const governorToGovernor = (g: string, nextId: string) => {
    const effect = C.PlutusData.from_bytes(fromHex(g)).as_list()
    const beforeE = effect?.get(0)
    const afterE = effect?.get(1)
    const after = afterE?.as_list()
    const before = beforeE?.as_list()
    if (!before || !after) throw "Governor to Governor failed."
    const thresholdsRaw = before?.get(0)
    const thresholds = thresholdsRaw.as_list()
    const propIdRaw = before?.get(1)
    const propId = propIdRaw?.as_integer()
    const propTimingsRaw = before?.get(2)
    const propTimings = propTimingsRaw?.as_list()
    const newProposalValidLengthRaw = before?.get(3)
    const newProposalValidLength = newProposalValidLengthRaw?.as_integer()
    const proposalsPerStakeRaw = before?.get(4)
    const proposalsPerStake = proposalsPerStakeRaw?.as_integer()
    const newThresholdsRaw = after?.get(0)
    const newThresholds = newThresholdsRaw?.as_list()
    const newPropTimingsRaw = after?.get(2)
    const newPropTimings = newPropTimingsRaw?.as_list()
    const newNewProposalValidLengthRaw = after?.get(3)
    const newNewProposalValidLength = newNewProposalValidLengthRaw?.as_integer()
    const newProposalsPerStakeRaw = after?.get(4)
    const newProposalsPerStake = newProposalsPerStakeRaw?.as_integer()
    if (!thresholds || !propId || !propTimings || !newProposalValidLength || !proposalsPerStake || !newThresholds || !newPropTimings || !newNewProposalValidLength || !newProposalsPerStake) throw "Governor to Governor failed."
    const governor: GovernorEffect = {
        thresholds: [BigInt(deserializeInt(thresholds?.get(0))), BigInt(deserializeInt(thresholds?.get(1))), BigInt(deserializeInt(thresholds?.get(2))), BigInt(deserializeInt(thresholds?.get(3))), BigInt(deserializeInt(thresholds?.get(4)))],
        propId: BigInt(nextId),
        propTimings: [new Date(Number(deserializeInt(propTimings?.get(0)))), new Date(Number(deserializeInt(propTimings?.get(1)))), new Date(Number(deserializeInt(propTimings?.get(2)))), new Date(Number(deserializeInt(propTimings?.get(3)))), new Date(Number(deserializeInt(propTimings?.get(4)))), new Date(Number(deserializeInt(propTimings?.get(5))))],
        newProposalValidLength: new Date(Number(deserializeInt(newProposalValidLength))),
        proposalsPerStake: BigInt(deserializeInt(proposalsPerStake)),
        newThresholds: [BigInt(deserializeInt(newThresholds!.get(0))), BigInt(deserializeInt(newThresholds!.get(1))), BigInt(deserializeInt(newThresholds!.get(2))), BigInt(deserializeInt(newThresholds!.get(3))), BigInt(deserializeInt(newThresholds!.get(4)))],
        newPropTimings: [new Date(Number(deserializeInt(newPropTimings!.get(0)))), new Date(Number(deserializeInt(newPropTimings!.get(1)))), new Date(Number(deserializeInt(newPropTimings!.get(2)))), new Date(Number(deserializeInt(newPropTimings!.get(3)))), new Date(Number(deserializeInt(newPropTimings!.get(4)))), new Date(Number(deserializeInt(newPropTimings!.get(5))))],
        newNewProposalValidLength: new Date(Number(deserializeInt(newNewProposalValidLength))),
        newProposalsPerStake: BigInt(deserializeInt(newProposalsPerStake))
    }
    return governor
}

export const mutateGovernorEndpoint = async (prisma: PrismaClient, reqBody: any) => {
    const parsedBody: UpdateGovernorBody = reqBody

    let skipCommunity = false;
    if (!parsedBody.communityId) {
        throw "No community id provided."
    }

    let community;
    try {
        if (!skipCommunity) {
            community = await prisma.community.findFirst({
                where: {
                    id: parsedBody.communityId
                }
            })
        }
    } catch (e) {
        console.log("No community present")
        throw e
    }
    if (!community && !skipCommunity) {
        throw "No Community present with id provided."
    }

    // Get the script params from the db. TODO
    let scriptParams = (await getScriptParamsForCommunity(prisma, parsedBody.communityId))
    let sp = scriptParams.daoScriptParams
    const governorPolicy = await getGovernorPolicy(sp)

    // Format the incoming request in order to properly create the relevant tx.
    const lucid = await getLucid(parsedBody.address, parsedBody.utxos)
    const effectUtxo = (await lucid.utxosByOutRef([parsedBody.effectUtxo]))[0]
    const governorUtxo = await lucid.utxoByUnit(lucid.utils.mintingPolicyToId(governorPolicy))
    const { nextPropId } = deserializeGov(governorUtxo.datum!)
    const governorUpdate = governorToGovernor(effectUtxo.datum!, nextPropId!.as_integer()!.to_str())
    const tx = await mutateGovernorTx(lucid, sp, effectUtxo, governorUpdate, governorUtxo, undefined) // This one may require reference scripts.
    let sTx = toHex(tx!.tx.txComplete.to_bytes())
    return sTx
}

export const spendFromTreasuryEndpoint = async (prisma: PrismaClient, reqBody: any) => {
    const parsedBody: SpendFromTreasuryBody = reqBody

    let skipCommunity = false;
    if (!parsedBody.communityId) {
        throw "No community id provided."
    }

    let community;
    try {
        if (!skipCommunity) {
            community = await prisma.community.findFirst({
                where: {
                    id: parsedBody.communityId
                }
            })
        }
    } catch (e) {
        console.log("No community present")
        throw e
    }
    if (!community && !skipCommunity) {
        throw "No Community present with id provided."
    }

    // Get the script params from the db. TODO
    let scriptParams = (await getScriptParamsForCommunity(prisma, parsedBody.communityId))
    let sp = scriptParams.daoScriptParams

    // Format the incoming request in order to properly create the relevant tx.
    const lucid = await getLucid(parsedBody.address, parsedBody.utxos)

    let utxos = await lucid.utxosAt(lucid.utils.validatorToAddress(await getGovernorValidator(sp)))
    utxos = utxos.filter((u) => {
        return u.txHash == sp!.gstOutRef.txOutRefId &&
        u.outputIndex == sp!.gstOutRef.txOutRefIdx
    })
    if (utxos.length != 1) throw "No governor UTxO found."

    let datum:any;
    try {
        datum = utxos[0].datum!
    } catch (e) {
        console.log(e)
        throw e
    }
    if (!datum) throw ""

    const effectUtxo = await lucid.utxosByOutRef([parsedBody.effectUtxo])
    if (effectUtxo.length != 1) throw "Could not find effect UTxO"
    const receivers = parsedBody.receivers.map((v) => {
        const r: [arg0: string, arg1: Assets, arg2: OutputData | undefined] = [v[0], convertAssetsStringToAssets(v[1]), v[2]]
        return r
    })


    const tx = await spendFromTreasuryTx(lucid, sp, effectUtxo[0], {receivers: receivers, treasuries: parsedBody.treasuries}, undefined, undefined)
    // TODO - add reference scripts when time permits, shouldn't be required for this tx at all

    // Return the tx to the user for signing.
    let sTx = toHex(tx!.tx.txComplete.to_bytes())

    return sTx
}