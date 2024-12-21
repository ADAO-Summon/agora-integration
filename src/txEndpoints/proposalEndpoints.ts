import { Prisma, PrismaClient } from '@prisma/client';
import { applyParamsToScript, Assets, Unit, Blockfrost, C, Credential, Datum, DatumHash, Lucid, Network, OutRef, Script, ScriptHash, ScriptType, toHex, UTxO, fromHex } from 'lucid-cardano'
import { bfKey, bfUrl, deserializeProposal, deserializeEffects, deserializeEffectsString, filterUtxosByDatum, filterUtxosByRef, getLucid, deserializeInt, deserializeStake, deserializeVotesString, deserializeGov } from '../summon-utils/util/sc.js'
import { ScriptParams, getGovernorValidator, getGovernorPolicy, getStakeValidator, getProposalValidator, getProposalPolicy, spendFromTreasury, getStakePolicy, mutateGovernor, getTreasuryValidator } from '../../resources/plutus.js';
import { createProposal, advanceProposal } from '../transactions/proposalTransactions.js'
import { postDatum } from '../transactions/arweave.js'
import { DaoSelection, deployReferenceUtxo, getReferenceUtxo, getScriptParamsForCommunity, returnAppropriateInfo } from './daoSelection.js'
import { MAKE_TREASURY_WITHDRAWAL } from '../summon-datums/agora/shared.js';
import { fetchBlockFrost } from './governorEndpoints.js';
import { GOVERNOR_UPDATE_DATUM, UPDATED_GOVERNOR } from '../summon-datums/agora/governor.js';

type AssetsString = Record<string, string>

type CreateProposalBody = {
    displayName: string | undefined,
    description: string | undefined,
    discussionUrl: string | undefined,
    address: string,
    communityId: string,
    effectScripts: Map<BigInt, Map<Script, [arg0: string, arg1: Script | undefined]>>,
    stakeTxHash: string,
    stakeIndex: number,
    utxos: OutRef[],
    dbEffects?: any[]
}

type EffectInfo = {
    effect: "Spend" | "Register" | "Delegate" | "Withdraw" | "EditDAO" | "UpdateManager",
    treasuries?: string[],
    receivers?: [string, AssetsString][],
    poolId?: string,
    config?: GovernorUpdate,
    managerInput?: string
}

type GovernorUpdate = {
    thresholds: [number, number, number, number, number, number],
    timingConfig: [Date, Date, Date, Date, Date, Date, Date, Date],
}

type EffectInfoOr = EffectInfo | undefined

type CreatePreconfiguredProposalBody = {
    displayName: string,
    description: string,
    discussionUrl: string | undefined,
    address: string,
    communityId: string,
    effectInfo: EffectInfo[][],
    stakeTxHash: string,
    stakeIndex: number,
    utxos: OutRef[]
}

type AdvanceProposalBody = {
    address: string,
    communityId: string,
    propId: string,
    utxos: OutRef[]
}

export const zip = (...arrays: any[]) => {
    return Array.apply(null,Array(arrays[0].length)).map(function(_,i){
        return arrays.map(function(array){return array[i]})
    });
}

export const sortArrayOfArrays = (arr: any[]): any[] => {
    return arr.sort((a, b) => a[0] - b[0]);
}

export const findOrCreateReference = async (prisma: PrismaClient, hash: string, content: string, type?: string) => {
    let store;
    try {
        store = await prisma.arweaveReference.findFirst({
            where: {
                cardano_hash: hash
            }
        });
        console.log(`Match found in DB for ${hash}`)
        console.log(store)
    } catch (e) {
        console.log(`No Match found in DB for ${hash}`, e);
    }
    if (!store) {
        console.log("New item being created in Database")
        try {
            const arweaveItem = await postDatum(content);
            store = await prisma.arweaveReference.create({
                data: {
                    cardano_hash: hash,
                    arweave_hash: arweaveItem,
                    language: type?.toString() || ""
                }
            });
        } catch (e) {
            throw e;
        }
    }
    return store;
}

export const prepareEffects = async (lucid: Lucid, effectScripts: Map<BigInt, Map<Script, [arg0: string, arg1: Script | undefined]>>, prisma: PrismaClient | undefined) => {
    let hashedEffects: Map<BigInt, Map<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]>> = new Map();
    let votes: Map<BigInt, BigInt> = new Map();

    const resultsArray = [...effectScripts.keys()];
    const valuesArray = [...effectScripts.values()];
    let resultsZipped = zip(resultsArray, valuesArray);

    for (let result of resultsZipped) {
        console.log(result);
        let hashedScripts: Map<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]> = new Map();
        let scriptMap: Map<Script, [arg0: string, arg1: Script | undefined]> = result[1];
        if (scriptMap == undefined) {
            console.log("No script map defined.");
            throw "No Script Map defined.";
        }

        let scripts: Script[] = [...scriptMap.keys()]
        for (let script of scripts) {
            console.log("Entered for", script);
            let datumAndScript: [arg0: string, arg1: Script | undefined] | undefined = scriptMap.get(script);
            if (!datumAndScript) throw "No datum and script found.";
            let datum = datumAndScript[0];
            console.log(datum);
            let maybeScript: Script | undefined = datumAndScript[1];
            console.log(maybeScript);

            let fScriptHash = lucid.utils.validatorToScriptHash(script);
            console.log(`fScriptHash for ${result[0]}: ${fScriptHash}`)
            let datumHash = lucid.utils.datumToHash(datum);
            let sScriptHash = maybeScript ? lucid.utils.validatorToScriptHash(maybeScript) : undefined;

            console.log("About to post to db.");
            if (prisma) {
                await findOrCreateReference(prisma, fScriptHash, script.script, script.type);
                if (datum !== "") await findOrCreateReference(prisma, datumHash, datum);
                if (sScriptHash && maybeScript) await findOrCreateReference(prisma, sScriptHash, maybeScript.script, maybeScript.type);
            }

            console.log("End of iter", fScriptHash, datumHash, sScriptHash);
            hashedScripts.set(fScriptHash, [datumHash, sScriptHash]);
        }

        console.log(`Result: ${result[0]}, ${[...result[1].keys()]}`);
        console.log(`Result: ${result[0]}, ${[...result[1].values()]}`);
        console.log(`HashedScripts: ${[...hashedScripts.keys()]}`);
        console.log(`HashedScripts: ${[...hashedScripts.values()]}`);
        hashedEffects.set(BigInt(result[0]), hashedScripts);
        votes.set(BigInt(result[0]), BigInt("0"));
    }
    return {hashedEffects, votes};
}

export const checkTxConfirmed = async (txHash: string) => {
    let txInfo = await fetchBlockFrost('txs', txHash);
    if (txInfo && txInfo.block) {
        let blockInfo = await fetchBlockFrost('blocks', txInfo.block);
        if (blockInfo && blockInfo.confirmations && blockInfo.confirmations > 6) {
            return true;
        }
    }
    return false;
}

export const getProposalUtxo = async (lucid: Lucid, prisma: PrismaClient, communityId: string, proposalId: string) => {
    const {daoScriptParams, daoId} = await getScriptParamsForCommunity(prisma, communityId)
    const scriptParams = daoScriptParams;
    const proposalScript = await getProposalValidator(scriptParams)
    const proposalValidatorAddress = lucid.utils.validatorToAddress(proposalScript)
    const proposalPolicyId = lucid.utils.mintingPolicyToId(await getProposalPolicy(scriptParams))
    const proposalUtxos: UTxO[] = await lucid.utxosAt(proposalValidatorAddress)
    const utxos: UTxO[] = proposalUtxos.filter((v: any, i: any, a: any) => {
        return v.assets[proposalPolicyId] > 0n
    })
    let theProposal: UTxO | undefined;
    const theRef = await getReferenceUtxo(prisma, lucid, communityId, 'ProposalValidator')
    for (let utxo of utxos) {
        let datum = utxo.datum
        if (!datum) throw "No datum found."
        let {propId} = deserializeProposal(datum)
        if (propId.as_integer()?.to_str() == proposalId) {
            theProposal = utxo;
        }
    }
    if (!theProposal) throw "No proposal found."
    return { theProposal, theRef };
}

/* The following are the prisma schemas for the serializeEffect function below.
model effect_info {
  id             String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  result         String
  effect         String
  pool_id        String?
  manager_input  String?
  proposal_id    String            @db.Uuid
  effect_index   String?
  proposal       proposal          @relation(fields: [proposal_id], references: [id])
  governor_input governor_update[]
  receivers      receiver[]
  treasuries     treasury[]
}

model treasury {
  id             String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  effect_info_id String      @db.Uuid
  treasury       String
  effect_info    effect_info @relation(fields: [effect_info_id], references: [id])
}

model receiver {
  id             String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  effect_info_id String      @db.Uuid
  receiver       String
  assets         asset[]
  effect_info    effect_info @relation(fields: [effect_info_id], references: [id])
}

model asset {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  receiver_id String   @db.Uuid
  asset_unit  String
  value       BigInt
  receiver    receiver @relation(fields: [receiver_id], references: [id])
}

model governor_update {
  id                  String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  create_max_width    DateTime
  proposals_per_stake BigInt
  effect_info_id      String          @db.Uuid
  effect_info         effect_info     @relation(fields: [effect_info_id], references: [id])
  thresholds          threshold[]
  timing_config       timing_config[]
}

model threshold {
  id                 String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  governor_update_id String          @db.Uuid
  execute            BigInt
  create             BigInt
  to_voting          BigInt
  vote               BigInt
  cosign             BigInt
  governorUpdate     governor_update @relation(fields: [governor_update_id], references: [id])
}

model timing_config {
  id                  String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  governor_update_id  String          @db.Uuid
  draft_time          DateTime
  voting_time         DateTime
  locking_time        DateTime
  executing_time      DateTime
  min_stake_vote_time DateTime
  vote_time_max_width DateTime
  governor_update     governor_update @relation(fields: [governor_update_id], references: [id])
}
*/

const serializeEffects = (effects: any) => {
    return effects.map((effect: any) => {
        // Serialize treasuries if needed (based on its structure)
        const serializedTreasuries = effect.treasuries.map((treasury: any) => {
            return {
                ...treasury,
                // Add any necessary transformations
            };
        });

        // Serialize receivers
        const serializedReceivers = effect.receivers.map((receiver: any) => {
            return {
                ...receiver,
                assets: receiver.assets.map((asset: any) => {
                    return {
                        ...asset,
                        value: asset.value.toString(), // Convert bigint to string
                    };
                }),
            };
        });

        // Serialize governor_input and other fields if necessary

        return {
            ...effect,
            treasuries: serializedTreasuries,
            receivers: serializedReceivers,
            // Add other fields after serialization
        };
    });
}

const combinedDbProposalInfo = async (prisma: PrismaClient, daoId: string, proposalId: number, processedDatum: any, theProposal: UTxO) => {
    let proposalsWithId: any[] = await prisma.proposal.findMany({
        where: {
            dao_id: daoId,
            proposal_id: proposalId
        }
    })
    let proposalOuter: any = undefined;
    for (let proposal of proposalsWithId) {
        if (proposal.confirmed) {
            proposalOuter = proposal
        } else if (await checkTxConfirmed(proposal.tx_hash)) {
            await prisma.proposal.update({
                where: { id: proposal.id },
                data: { confirmed: true },
            });
            proposalOuter = proposal
        } else if (new Date().getTime() - proposal.created_at.getTime() > 900000) {
        }
    }
    if (!proposalOuter) {
        return {didntprocess: "true", ...processedDatum}
    } else {
        const allEffects = await prisma.effect_info.findMany({
            where: {
                proposal_id: proposalOuter.id
            },
            include: {
                treasuries: true,
                receivers: {
                    include: {
                        assets: true,
                    }
                },
                governor_input: true,
            },
        })
        return { // Description, Name, and Link
            proposalId: processedDatum.proposalId,
            utxo: {txHash: theProposal.txHash, outputIndex: theProposal.outputIndex},
            name: proposalOuter.name,
            description: proposalOuter.description,
            discussion_url: proposalOuter.discussion_url,
            statusString: processedDatum.statusString,
            amountOfCosigners: processedDatum.amountOfCosigners,
            cosignerUtxos: processedDatum.cosignerUtxos,
            amountCosigned: processedDatum.amountCosigned,
            deserializedEffects: processedDatum.deserializeEffects,
            deserializedVotes: processedDatum.deserializedVotes,
            deserializedThresholds: processedDatum.deserializedThresholds,
            deserializedTimingConfig: processedDatum.deserializedTimingConfig,
            startingTimeDate: processedDatum.startingTimeDate,
            allEffects: serializeEffects(allEffects),
        }
    }
}

export const getProposalPageInfo = async (prisma: PrismaClient, communityId: string, inputProposalId: string) => {
    const lucid = await getLucid(undefined, undefined)
    const { theProposal } = await getProposalUtxo(lucid, prisma, communityId, inputProposalId)
    const {daoScriptParams, daoId} = await getScriptParamsForCommunity(prisma, communityId)
    const scriptParams = daoScriptParams;
    const stakeValidator = await getStakeValidator(scriptParams)
    const stakeValidatorAddress = lucid.utils.validatorToAddress(stakeValidator)
    const stakePolicyId = lucid.utils.mintingPolicyToId(await getStakePolicy(scriptParams))
    const allStakeUTxOs = (await lucid.utxosAt(stakeValidatorAddress)).filter((v: UTxO) => {
        return BigInt(v.assets[stakePolicyId + lucid.utils.validatorToScriptHash(stakeValidator)].toString() || "0") > 0n
    })
    const processedDatum = (await processProposalDatum(scriptParams.gtClassRef[0] + scriptParams.gtClassRef[1], theProposal.datum || "", allStakeUTxOs))
    console.log('processedDatum', processedDatum)
    return await combinedDbProposalInfo(prisma, daoId, Number(inputProposalId), processedDatum, theProposal)
}

const getCosignerInfo = (proposalId: string, gtUnit: string, stakeUtxos: UTxO[]) => {
    let cosignedTotal = 0n
    let cosignerUtxos: OutRef[] = []
    for (let utxo of stakeUtxos) {
        let stakeDatum = utxo.datum
        if (!stakeDatum) throw "No datum found."
        let {propLocks} = deserializeStake(stakeDatum)
        // If the proposal locks has this proposal, and it is a cosign lock, we add the value
        const propLockLength = propLocks.as_list()?.len() || 0
        for (let i = 0; i < propLockLength; i++) {
            const lock = propLocks.as_list()?.get(i)
            console.log(toHex(lock?.to_bytes() || new Uint8Array(0)))
            if (!lock) {
                throw `No lock found at index ${i}. Length: ${propLockLength}`
            }
            const supposedProposal = lock.as_list()?.get(0)
            if (!supposedProposal) throw "No supposed proposal found."
            const supposedProposalId = deserializeInt(supposedProposal)
            if (supposedProposalId == proposalId) {
                const lockState = deserializeInt(lock.as_list()?.get(1).as_constr_plutus_data()?.alternative())
                if (lockState == "0" || lockState == "2") {
                    cosignerUtxos.push({txHash: utxo.txHash, outputIndex: utxo.outputIndex})
                    cosignedTotal = cosignedTotal + utxo.assets[gtUnit]
                }
                console.log(`Lock State: ${lockState}`)
            }
        }
    }
    return {cosignerUtxos, cosignedTotal}
}

const processProposalStatus = (statusInt: string) => {
    let statusString = ""
    switch (Number(statusInt)) {
        case 0: statusString = "Draft"
            break;
        case 1: statusString = "Voting"
            break;
        case 2: statusString = "Locked"
            break;
        case 3: statusString = "Finished"
            break;
    }
    return statusString
}

export const handleTimingConfig = (timingConfig: any): [Date, Date, Date, Date, Date, Date] => {
    console.log("about to deserialize draft time")
    const draftTime = deserializeInt(timingConfig.as_list()?.get(0))
    console.log("about to deserialize voting time")
    const votingTime = deserializeInt(timingConfig.as_list()?.get(1))
    console.log("about to deserialize lock time")
    const lockTime = deserializeInt(timingConfig.as_list()?.get(2))
    console.log("about to deserialize execute time")
    const executeTime = deserializeInt(timingConfig.as_list()?.get(3))
    console.log("about to deserialize min stake locked")
    const minStakeLocked = deserializeInt(timingConfig.as_list()?.get(4))
    console.log("about to deserialize voting time width")
    const votingTimeWidth = deserializeInt(timingConfig.as_list()?.get(5))
    return [new Date(Number(draftTime)), new Date(Number(votingTime)), new Date(Number(lockTime)), new Date(Number(executeTime)), new Date(Number(minStakeLocked)), new Date(Number(votingTimeWidth))]
}

export const handleThresholds = (thresholds: any): [string, string, string, string, string] => {
    console.log("about to deserialize draft time")
    const execute = deserializeInt(thresholds.as_list()?.get(0))
    console.log("about to deserialize voting time")
    const create = deserializeInt(thresholds.as_list()?.get(1))
    console.log("about to deserialize lock time")
    const toVoting = deserializeInt(thresholds.as_list()?.get(2))
    console.log("about to deserialize execute time")
    const toVote = deserializeInt(thresholds.as_list()?.get(3))
    console.log("about to deserialize min stake locked")
    const toCosign = deserializeInt(thresholds.as_list()?.get(4))
    return [execute, create, toVoting, toVote, toCosign]
}

const processProposalDatum = async (gtUnit: string, datum: Datum, stakeUtxos: UTxO[]) => {
    const {propId, effects, status, cosigners, thresholds, votes, timingConfig, startingTime} = deserializeProposal(datum)
    const proposalId = deserializeInt(propId)
    const {cosignerUtxos, cosignedTotal} = getCosignerInfo(proposalId, gtUnit, stakeUtxos)

    const statusInt = deserializeInt(status)
    const statusString = processProposalStatus(statusInt)

    const amountOfCosigners = cosigners.as_list()?.len() || 0

    // Here we should handle the effects / votes.
    let deserializedEffects: Record<string, Record<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]>> = deserializeEffectsString(effects)
    // Here we need to look in the database to see whether or not we can find the effects, if we cannot, then we return "unknown script".
    // If the script is custom, that's also considered unknown.
    // We require that unknown scripts are published prior to their usage in execution.

    let deserializedVotes: Record<string, string> = deserializeVotesString(votes)

    // Then we must handle the thresholds and timing config.
    let deserializedThresholds: [string, string, string, string, string] = handleThresholds(thresholds)
    let deserializedTimingConfig: [Date, Date, Date, Date, Date, Date] = handleTimingConfig(timingConfig)

    console.log("cosignerInfo", {cosignerUtxos, cosignedTotal}, proposalId, stakeUtxos)

    const startingTimeDate = new Date(Number(deserializeInt(startingTime)))
    return { 
        proposalId,
        statusString,
        amountOfCosigners: amountOfCosigners.toString(),
        cosignerUtxos,
        amountCosigned: cosignedTotal.toString(),
        deserializeEffects: deserializedEffects,
        deserializedVotes: deserializedVotes,
        deserializedThresholds,
        deserializedTimingConfig,
        startingTimeDate
    }
}

export const getCommunityProposals = async (prisma: PrismaClient, communityId: string) => {
    const lucid = await getLucid(undefined, undefined)
    const {daoScriptParams, daoId} = await getScriptParamsForCommunity(prisma, communityId)
    const scriptParams = daoScriptParams;

    const proposals = await prisma.proposal.findMany({
        where: {
            dao_id: daoId
        }
    })
    if (!proposals) throw new Error("No proposals found for this community.")

    const proposalValidatorAddress = lucid.utils.validatorToAddress(await getProposalValidator(scriptParams))
    const stakeValidator = await getStakeValidator(scriptParams)
    const stakeValidatorAddress = lucid.utils.validatorToAddress(stakeValidator)
    const proposalPolicyId = lucid.utils.mintingPolicyToId(await getProposalPolicy(scriptParams))
    const stakePolicyId = lucid.utils.mintingPolicyToId(await getStakePolicy(scriptParams))
    const utxos: UTxO[] = (await lucid.utxosAt(proposalValidatorAddress)).filter((v: any, i: any, a: any) => {
        return v.assets[proposalPolicyId] > 0n
    })
    const unfilteredStakeUtxos = await lucid.utxosAt(stakeValidatorAddress)
    console.log('unfilteredStakeUtxos', unfilteredStakeUtxos)
    const stakeUtxos: UTxO[] = unfilteredStakeUtxos.filter((v: any, i: any, a: any) => {
        return v.assets[stakePolicyId + lucid.utils.validatorToScriptHash(stakeValidator)] > 0n
    })
    console.log('stakeUtxos', stakeUtxos)
    let processedUtxos: any[] = []
    for (let utxo of utxos) {
        let datum = utxo.datum
        if (datum) {
            let {proposalId, statusString, amountOfCosigners, amountCosigned, startingTimeDate} = await processProposalDatum(daoScriptParams.gtClassRef[0] + daoScriptParams.gtClassRef[1], datum, stakeUtxos)
            let proposalsWithId = proposals.filter((v: any, i: any, a: any) => {
                console.log(v.proposal_id.toString(), proposalId)
                return v.proposal_id.toString() == proposalId
            })
            
            let addedPropoasl = false;
            console.log(proposals)
            console.log(proposalsWithId)
            for (let proposal of proposalsWithId) {
                if (proposal.confirmed) {
                    processedUtxos.push({
                        txHash: utxo.txHash,
                        outputIndex: utxo.outputIndex,
                        datum: utxo.datum,
                        datumProcessed: {proposalId, statusString, amountOfCosigners, amountCosigned, startingTimeDate},
                        name: proposal.name || `Proposal ${proposalId}`,
                        description: proposal.description,
                        discussionUrl: proposal.discussion_url,
                    })
                    addedPropoasl = true;
                } else if (await checkTxConfirmed(proposal.tx_hash)) {
                    await prisma.proposal.update({
                        where: { id: proposal.id },
                        data: { confirmed: true },
                    });
                    processedUtxos.push({
                        txHash: utxo.txHash,
                        outputIndex: utxo.outputIndex,
                        datum: utxo.datum,
                        datumProcessed: {proposalId, statusString, amountOfCosigners, amountCosigned, startingTimeDate},
                        name: proposal.name || `Proposal ${proposalId}`,
                        description: proposal.description,
                        discussionUrl: proposal.discussion_url,
                    })
                    addedPropoasl = true;
                } else if (new Date().getTime() - proposal.created_at.getTime() > 900000) {
                    // Delete the proposal which was not confirmed.
                    // await prisma.proposal.delete({
                        // where: { id: proposal.id },
                    // });
                }
            }
            if (!addedPropoasl) {
                processedUtxos.push({
                    txHash: utxo.txHash,
                    outputIndex: utxo.outputIndex,
                    datum: utxo.datum,
                    datumProcessed: {proposalId, statusString, amountOfCosigners, amountCosigned, startingTimeDate},
                    name: `Proposal ${proposalId}`,
                })
            }
        }
    }

    return processedUtxos
}

const handleDbProposal = async (prisma: PrismaClient, proposalId: string, dbEffects: any[]) => {
    // effect: "Spend" | "Delegate" | "Withdraw" | "EditDAO" | "UpdateManager",
    for (let dbEffect of dbEffects) {
        switch (dbEffect.effect) {
            case "Spend":
                const effectInfo = await prisma.effect_info.create({
                    data: {
                        result: dbEffect.result,
                        effect_index: dbEffect.effect_index,
                        proposal_id: proposalId,
                        effect: dbEffect.effect,
                    }
                })
                for (let treasury of dbEffect.treasuries) {
                    const t = treasury as Credential
                    await prisma.treasury.create({
                        data: {
                            effect_info_id: effectInfo.id,
                            treasury: t.hash
                        }
                    })
                }
                for (let receiver of dbEffect.receivers) {
                    const r = receiver as [Credential, Assets]
                    const dbReceiver = await prisma.receiver.create({
                        data: {
                            effect_info_id: effectInfo.id,
                            receiver: r[0].hash,
                        }
                    })
                    for (let unit in r[1]) {
                        await prisma.asset.create({
                            data: {
                                receiver_id: dbReceiver.id,
                                asset_unit: unit,
                                value: r[1][unit]
                            }
                        })
                    }
                }

                break;
            case "EditDAO":
                console.log("dbEffect", dbEffect)
                const editDAOEffectInfo = await prisma.effect_info.create({
                    data: {
                        result: dbEffect.result,
                        effect_index: dbEffect.effect_index,
                        proposal_id: proposalId,
                        effect: dbEffect.effect,
                    }
                })
                const dbGovernorUpdate = await prisma.governor_update.create({
                    data: {
                        create_max_width: dbEffect.config.timingConfig[6],
                        proposals_per_stake: dbEffect.config.thresholds[5],
                        effect_info_id: editDAOEffectInfo.id
                    }
                })
                await prisma.threshold.create({
                    data: {
                        governor_update_id: dbGovernorUpdate.id,
                        execute: dbEffect.config.thresholds[0],
                        create: dbEffect.config.thresholds[1],
                        to_voting: dbEffect.config.thresholds[2],
                        vote: dbEffect.config.thresholds[3],
                        cosign: dbEffect.config.thresholds[4],
                    }
                })
                await prisma.timing_config.create({
                    data: {
                        governor_update_id: dbGovernorUpdate.id,
                        draft_time: dbEffect.config.timingConfig[0],
                        voting_time: dbEffect.config.timingConfig[1],
                        locking_time: dbEffect.config.timingConfig[2],
                        executing_time: dbEffect.config.timingConfig[3],
                        min_stake_vote_time: dbEffect.config.timingConfig[4],
                        vote_time_max_width: dbEffect.config.timingConfig[5],
                    }
                })
                break;
            case "UpdateManager":
                break;
            case "Delegate":
                break;
            case "Withdraw":
                break;
            default:
                // We treat this as the null result.
                break;
        }
    }
        
}

export const createProposalEndpoint = async (prisma: PrismaClient, userId: string, submitReqBod: any) => {
    const submitReqBody = submitReqBod as CreateProposalBody
    console.log(submitReqBody)
    const lucid = await getLucid(submitReqBody.address, submitReqBody.utxos)
    const aDetails = lucid.utils.getAddressDetails(submitReqBody.address)
    const cred = aDetails.paymentCredential ? aDetails.paymentCredential : undefined
    if (cred == undefined) throw "The users credential cannot be undefined."
    const {daoScriptParams, daoId} = await getScriptParamsForCommunity(prisma, submitReqBody.communityId)
    const scriptParams = daoScriptParams;
    console.log("daoSelectionInfo", scriptParams)

    // Get the Governor UTxO by the policy of the ScriptParams.
    const governorValidator = await getGovernorValidator(scriptParams)
    const governorValidatorAddress = lucid.utils.validatorToAddress(governorValidator)
    const governorPolicy = await getGovernorPolicy(scriptParams)
    console.log('govPolId', lucid.utils.validatorToScriptHash(governorPolicy))
    let gUtxos = await lucid.utxosAt(governorValidatorAddress)
    console.log('gUtxos[0]', gUtxos[0])
    console.log(gUtxos.length)
    let gUtxo = gUtxos.filter((v: any, i: any, a: any) => {
        return v.assets[lucid.utils.validatorToScriptHash(governorPolicy)] > 0n
    })[0]
    
    console.log("Defined gUTxO.", gUtxo.txHash, gUtxo.outputIndex)

    const proposalPolicy = await getProposalPolicy(scriptParams)

    if (gUtxo.datum == undefined) { throw "" }

    const stakeValidator = await getStakeValidator(scriptParams)
    const stakeValidatorAddress = lucid.utils.validatorToAddress(stakeValidator)
    const sUtxos = await lucid.utxosAt(stakeValidatorAddress)
    
    const sRefUtxos = filterUtxosByRef(sUtxos, submitReqBody.stakeTxHash, submitReqBody.stakeIndex, undefined)
    let sUtxo = sRefUtxos[0]

    console.log("About to prepare the effects.")
    console.log('effectScripts', submitReqBody.effectScripts)
    let effectScripts = submitReqBody.effectScripts
    const {hashedEffects, votes} = await prepareEffects(lucid, effectScripts, prisma)

    const readFromProposalPolicyUtxo = await getReferenceUtxo(prisma, lucid, submitReqBody.communityId, 'ProposalPolicy')
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, submitReqBody.communityId, 'StakeValidator')
    const readFromGovernorUtxo = await getReferenceUtxo(prisma, lucid, submitReqBody.communityId, 'GovernorValidator')

    console.log("About to build the tx.")
    let { tx, proposalId } =
        await createProposal(lucid, scriptParams, sUtxo, sUtxo.datum || "", gUtxo, gUtxo.datum, {effects: hashedEffects, votes: votes}, readFromStakeUtxo, readFromProposalPolicyUtxo, readFromGovernorUtxo)
    
    const txHash = tx.toHash()
    const dbProposal = await prisma.proposal.create({
        data: {
            tx_hash: txHash,
            dao_id: daoId,
            proposal_id: proposalId,
            name: submitReqBody.displayName,
            description: submitReqBody.description,
            discussion_url: submitReqBody.discussionUrl,
        }
    })
    if (submitReqBody.dbEffects) {
        console.log("handling effects")
        await handleDbProposal(prisma, dbProposal.id, submitReqBody.dbEffects)
    }
    
    let sTx = toHex(tx.txComplete.to_bytes())
    
    return sTx
}

export const advanceProposalEndpoint = async (prisma: PrismaClient, submitReqBod: any) => {
    console.log(submitReqBod)
    const submitReqBody = submitReqBod as AdvanceProposalBody
    const lucid = await getLucid(submitReqBody.address, submitReqBody.utxos)
    const aDetails = lucid.utils.getAddressDetails(submitReqBody.address)
    const cred = aDetails.paymentCredential ? aDetails.paymentCredential : undefined
    if (cred == undefined) throw "The users credential cannot be undefined."

    const daoScriptParams = await getScriptParamsForCommunity(prisma, submitReqBody.communityId)

    // Get the Governor UTxO by the policy of the ScriptParams.
    const governorValidatorAddress = lucid.utils.validatorToAddress((await getGovernorValidator(daoScriptParams.daoScriptParams)))
    let gUtxos = await lucid.utxosAtWithUnit(governorValidatorAddress, lucid.utils.validatorToScriptHash((await getGovernorPolicy(daoScriptParams.daoScriptParams))))
    let gUtxo = gUtxos[0]

    const stakeValidatorAddress = lucid.utils.validatorToAddress((await getStakeValidator(daoScriptParams.daoScriptParams)))
    let sUtxos = await lucid.utxosAt(stakeValidatorAddress)

    const { theProposal, theRef } = await getProposalUtxo(lucid, prisma, submitReqBody.communityId, submitReqBody.propId)
    const pUtxo = theProposal
    console.log("pUtxo", pUtxo)
    const dbProposal = await prisma.proposal.findFirst({
        where: {
            dao_id: daoScriptParams.daoId,
            proposal_id: Number(submitReqBody.propId),
            confirmed: true
        }
    })
    if (!dbProposal) throw "No proposal found."

    const cosignerInfo = getCosignerInfo(submitReqBody.propId, daoScriptParams.daoScriptParams.gtClassRef[0] + daoScriptParams.daoScriptParams.gtClassRef[1], sUtxos)
    const cosignerUtxos = await lucid.utxosByOutRef(cosignerInfo.cosignerUtxos)
    console.log("witnessesing", cosignerUtxos.length, "utxos.")

    let {effects} = deserializeProposal(pUtxo.datum || "")
    let deserializedEffects: Map<BigInt, Map<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]>> = deserializeEffects(effects)
    let scriptMap: Map<BigInt, Map<Script, [arg0: Datum, arg1: Script | undefined]>> = new Map()

    for (let resultPair of deserializedEffects) {
        console.log("outer.")
        let resultTag = resultPair[0]
        console.log(resultTag)
        let innerMap: Map<Script, [arg0: Datum, arg1: Script | undefined]> = new Map()
        const effectInfos = (await prisma.effect_info.findMany({
            where: {
                result: resultTag.toString(),
                proposal_id: dbProposal.id,
            }
        })).sort((a, b) => {
            return Number(a.effect_index) - Number(b.effect_index)
        })
        for (let i = 0; i < effectInfos.length; i++) {
            // resultPair[1].keys(); ) {
            try {
                console.log("inner")
                let effectInfo = effectInfos[i]
                let script: Script | undefined = undefined;
                let datum: string | undefined = undefined;
                if (effectInfo.effect == "Spend") {
                    const receivers = await prisma.receiver.findMany({
                        where: {
                            effect_info_id: effectInfo.id
                        },
                        include: {
                            assets: true
                        }
                    })
                    const treasuries = await prisma.treasury.findMany({
                        where: {
                            effect_info_id: effectInfo.id
                        }
                    })
                    const ass = (a: any[]) => {
                        let r: Assets = {}
                        for (let i in a) {
                            let o: any = i
                            r[o.asset_unit] = o.value
                        }
                        return r
                    }
                    script = await spendFromTreasury(daoScriptParams.daoScriptParams)
                    datum = toHex(MAKE_TREASURY_WITHDRAWAL(
                        receivers.map((v: any) => {
                            return [
                                {type: 'Script', hash: v.receiver} as Credential,
                                ass(v.assets)
                            ]
                        }),
                        treasuries.map((v: any) => {return {type: 'Script', hash: v.treasury} as Credential})).to_bytes()
                    )
                }
                if (effectInfo.effect == "EditDAO") {
                    const {propThresholds, nextPropId, timingConfig, maxTimeRange, maxProposalsPerStake} = deserializeGov(gUtxo.datum!)
                    const propIdAsPData = C.PlutusData.new_integer(C.BigInt.from_str(submitReqBody.propId))
                    const govInfo = await prisma.governor_update.findFirst({
                        where: {
                            effect_info_id: effectInfo.id
                        },
                        include: {
                            thresholds: true,
                            timing_config: true,
                        }
                    })
                    script = await mutateGovernor(daoScriptParams.daoScriptParams)
                    datum = GOVERNOR_UPDATE_DATUM(
                        propThresholds,
                        propIdAsPData,
                        timingConfig,
                        maxProposalsPerStake,
                        maxTimeRange,
                        [
                            govInfo!.thresholds.at(0)!.execute,
                            govInfo!.thresholds.at(0)!.create,
                            govInfo!.thresholds.at(0)!.to_voting,
                            govInfo!.thresholds.at(0)!.vote,
                            govInfo!.thresholds.at(0)!.cosign,
                        ],
                        [
                            new Date(govInfo!.timing_config.at(0)!.draft_time),
                            new Date(govInfo!.timing_config.at(0)!.voting_time),
                            new Date(govInfo!.timing_config.at(0)!.locking_time),
                            new Date(govInfo!.timing_config.at(0)!.executing_time),
                            new Date(govInfo!.timing_config.at(0)!.min_stake_vote_time),
                            new Date(govInfo!.timing_config.at(0)!.vote_time_max_width)
                        ],
                        new Date(govInfo!.create_max_width),
                        govInfo!.proposals_per_stake,
                    )
                }
                if (!script) throw "Script is undefined."
                if (!datum) throw "Datum is undefined."

                innerMap.set(script, [datum, undefined])

            } catch (e) {
                console.log(e)
            }
            /*try {
                console.log("inner")
                let scriptHash = scriptPair[0]
                let datumHash = scriptPair[1][0]
                let maybeRefScript = scriptPair[1][1]
                let scriptStore;
                try {
                    scriptStore = await prisma.arweaveReference.findFirst({
                    where: {
                        cardano_hash: scriptHash
                    }
                    })
                } catch (e) {
                    console.log(e)
                }
                if (!scriptStore) {
                    throw "Uh oh, no script found in advance proposal. Register One?"
                }
                let datumStore;
                try {
                    datumStore = await prisma.arweaveReference.findFirst({
                    where: {
                        cardano_hash: datumHash
                    }
                    })
                } catch (e) {
                    console.log("New user being created in Database")
                    console.log(e)
                }
                if (!datumStore) {
                    throw "Uh oh, no datum found in advance proposal. Register One?"
                }
                let ts = scriptStore.language || ""
                let t: ScriptType | undefined = undefined
                if (ts == "Native") {
                    t = "Native"
                } else if (ts == "PlutusV1") {
                    t = "PlutusV1"
                } else if (ts == "PlutusV2") {
                    t = "PlutusV2"
                } else throw "Script Type is invalid."
                if (t != undefined) {
                    const scriptFromArweave = await (await fetch(`https://arweave.net/${scriptStore.arweave_hash}`)).text()
                    const datumFromArweave = await (await fetch(`https://arweave.net/${datumStore.arweave_hash}`)).text() 
                    innerMap.set({type: t, script: scriptFromArweave}, [datumFromArweave, undefined])
                    // Future Feature: Ref Scripts on Effects? Not sure if it's worth it.
                }
            } catch (e) {
                console.log(e)
            }*/
        }
        scriptMap.set(resultTag, innerMap)
    }

    // -- Deprecated this way, we just always use bundlr?
    // const info = await getEffectInfoFromDb(prisma, submitReqBody.propId)
    // const effectInfo: EffectInfo[][] = info.effectInfo

    console.log("after loop")
    const refList = theRef ? [theRef] : undefined
    const readFromGovernorUtxo = await getReferenceUtxo(prisma, lucid, submitReqBody.communityId, 'GovernorValidator')

    let {tx} = await advanceProposal(lucid, daoScriptParams.daoScriptParams, pUtxo, pUtxo.datum || "", gUtxo, gUtxo.datum || "", scriptMap, cosignerUtxos, refList, readFromGovernorUtxo ? [readFromGovernorUtxo] : undefined)
    let sTx = toHex(tx.txComplete.to_bytes())
    
    return sTx
}

export const convertAssetsStringToAssets = (assetsString: AssetsString): Assets => {
    let assets: Assets = {};
    for (let key in assetsString) {
      assets[key] = BigInt(assetsString[key]);
    }
    return assets;
}

const getScriptMapFromInfo = async (
        lucid: Lucid,
        results: EffectInfo[][],
        daoTreasuries: string[],
        gUtxo: UTxO,
        scriptParams: ScriptParams
) => {
    let effects: Map<BigInt, Map<Script, [arg0: string, arg1: Script | undefined]>> = new Map()
    let dbEffects: any[] = []
    for (const key in results) {
        console.log("result key", key)
        let effectMap: Map<Script, [arg0: string, arg1: Script | undefined]> = new Map()
        let effectInfo = results[key]
        if (!effectInfo) throw "Effect Info cannot be undefined."
        console.log('effectInfo', effectInfo)
        for (let i = 0; i < effectInfo.length; i++) {
            let effect = effectInfo[i]
            console.log(effect.effect)
            let script: Script | undefined;
            switch (effect.effect) {
                case "Spend":
                    script = await spendFromTreasury(scriptParams)
                    let receivers: [arg0: Credential, arg1: Assets][] = []
                    let treasuries: Credential[] = []
                    if (!effect.receivers) throw "Receivers cannot be undefined."
                    // if (!effect.treasuries) throw "Treasuries cannot be undefined."
                    for (let receiver of effect.receivers) {
                        let cred = lucid.utils.getAddressDetails(receiver[0]).paymentCredential
                        if (!cred) throw "The users credential cannot be undefined."
                        receivers.push([cred, convertAssetsStringToAssets(receiver[1])])
                    }
                    for (let treasury of daoTreasuries) {
                        let cred = lucid.utils.getAddressDetails(treasury).paymentCredential
                        if (!cred) throw "The treasury credential cannot be undefined."
                        treasuries.push(cred)
                    }
                    effectMap.set(
                        script,
                        [toHex(MAKE_TREASURY_WITHDRAWAL(receivers, treasuries).to_bytes()), undefined]
                    )
                    dbEffects.push({
                        result: key,
                        effect_index: i.toString(),
                        effect: "Spend",
                        receivers: receivers,
                        treasuries: treasuries
                    })
                    break;
                case "Register":
                    // fail here
                    throw "Register is not yet supported."
                    break;
                case "Delegate":
                    // fail here
                    throw "Delegate is not yet supported."
                    break;
                case "Withdraw":
                    // fail here
                    throw "Withdraw is not yet supported."
                    break;
                case "EditDAO":
                    script = await mutateGovernor(scriptParams)
                    if (!script) throw "Script cannot be undefined."
                    let governorInput = effect.config
                    if (!governorInput) throw "Governor Input cannot be undefined."

                    // We need to get the governor from the UTxO and use it with the governor input.
                    let governorDatum = gUtxo.datum || ""
                    if (!governorDatum) throw "Governor Datum cannot be undefined."
                    let { propThresholds, nextPropId, timingConfig, maxTimeRange, maxProposalsPerStake} = deserializeGov(governorDatum)

                    let governorUpdateDatum = GOVERNOR_UPDATE_DATUM(
                            propThresholds,
                            nextPropId,
                            timingConfig,
                            maxProposalsPerStake,
                            maxTimeRange,
                            [
                                BigInt(governorInput.thresholds[0]),
                                BigInt(governorInput.thresholds[1]),
                                BigInt(governorInput.thresholds[2]),
                                BigInt(governorInput.thresholds[3]),
                                BigInt(governorInput.thresholds[4])
                            ],
                            [
                                new Date(governorInput.timingConfig[0]),
                                new Date(governorInput.timingConfig[1]),
                                new Date(governorInput.timingConfig[2]),
                                new Date(governorInput.timingConfig[3]),
                                new Date(governorInput.timingConfig[4]),
                                new Date(governorInput.timingConfig[5]),
                            ],
                            new Date(governorInput.timingConfig[6]),
                            BigInt(governorInput.thresholds[5])
                    )
                    effectMap.set(
                        script,
                        [governorUpdateDatum, undefined]
                    )
                    dbEffects.push({
                        result: key,
                        effect_index: i.toString(),
                        effect: "EditDAO",
                        config: effect.config
                    })
                    break;
                case "UpdateManager":
                    throw "This is not yet supported."
                default:
                    throw "The effect described is not supported."
            }
        }
        console.log('effectMap', effectMap)
        effects.set(BigInt(key), effectMap)
    }
    return { effects, dbEffects }
}


export const createProposalPreconfiguredEndpoint = async (prisma: PrismaClient, userId: string, submitReqBod: any) => {
    const submitReqBody = submitReqBod as CreatePreconfiguredProposalBody
    console.log(JSON.stringify(submitReqBody))

    const lucid = await getLucid(submitReqBody.address, submitReqBody.utxos)
    const aDetails = lucid.utils.getAddressDetails(submitReqBody.address)
    const cred = aDetails.paymentCredential ? aDetails.paymentCredential : undefined
    if (cred == undefined) throw "The users credential cannot be undefined."

    const { daoScriptParams, daoId } = await getScriptParamsForCommunity(prisma, submitReqBody.communityId)
    const scriptParams = daoScriptParams;

    const daoTreasury = await prisma.dao.findFirst({
        where: {
            id: daoId
        }
    })
    if (!daoTreasury) throw "No treasury found for this DAO."

    const daoTreasuries = [daoTreasury.treasury_addr]

    // Get the Governor UTxO by the policy of the ScriptParams.
    const governorValidatorAddress = lucid.utils.validatorToAddress((await getGovernorValidator(scriptParams)))
    let gUtxos = await lucid.utxosAtWithUnit(governorValidatorAddress, lucid.utils.validatorToScriptHash((await getGovernorPolicy(scriptParams))))
    let gUtxo = gUtxos[0]

    const sUtxos = await lucid.utxosByOutRef([{txHash: submitReqBody.stakeTxHash, outputIndex: submitReqBody.stakeIndex} || {txHash: "", outputIndex: 0}])

    console.log(`Witnessing ${sUtxos.length} stake UTxOs.`)

    const { effects, dbEffects } = await getScriptMapFromInfo(
        lucid,
        submitReqBody.effectInfo,
        daoTreasuries,
        gUtxo,
        scriptParams
    )

    let b: CreateProposalBody = {
        displayName: submitReqBody.displayName,
        description: submitReqBody.description,
        discussionUrl: submitReqBody.discussionUrl,
        address: submitReqBody.address,
        communityId: submitReqBody.communityId,
        effectScripts: effects,
        stakeTxHash: submitReqBody.stakeTxHash,
        stakeIndex: submitReqBody.stakeIndex,
        utxos: submitReqBody.utxos,
        dbEffects: dbEffects
    }

    let sTx = await createProposalEndpoint(prisma, userId, b)
    
    return sTx
}