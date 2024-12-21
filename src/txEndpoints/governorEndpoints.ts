import { PrismaClient } from '@prisma/client';
import { getAuthorityPolicy, getGovernorPolicy, getTreasuryValidator, ScriptParams } from '../../resources/plutus.js'
import { createGovernor } from '../transactions/index.js'
import { deserializeGov, getLucid } from '../summon-utils/util/sc.js'
import { GOVERNOR_DATUM } from '../summon-datums/agora/governor.js'
import { toHex, OutRef, Credential } from 'lucid-cardano';
import { SERVICES } from '../constants.js'
import { getRandomDescription, getRandomName } from '../communityNames.js';

type CreateGovernorBody = {
    communityId: string | undefined,
    address: string,
    govTokenPolicy: string,
    govTokenName: string,
    thresholds: [number, number, number, number, number],
    timingConfig: [Date, Date, Date, Date, Date, Date],
    maxWidth: Date,
    maxProposalsPerStake: number,
    maximumCosigners: number,
    utxos: OutRef[]
}

const createDaoCommunityRelations = async (communityIds: string[], daoId: string, userId: string) => {
    const body = {
        ids: communityIds,
        connectToId: daoId,
        userId,
        connectTo: "dao"
    }

    const options = {
        method: 'POST',
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.SUMMON_JWT}` }, //signedRequest.signed_request() as string },
        body: JSON.stringify(body)
    }

    return fetch(`${SERVICES.DATA_SERVICE}/connectCommunitiesTo`, options)
}

const createNewCommunityDep = async (name: string, description: string, authHeader: string, userAddr: string) => {
        const body = {
            displayName: name,
            description: description,
            manager: userAddr
        }
        console.log('createNewCommunity', body)
    
        const stringified = JSON.stringify(body)
    
        console.log('stringified', stringified)
    
        const resp = await fetch(SERVICES.DATA_SERVICE + "/createNewCommunity", {
            body: stringified,
            method: 'POST',
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.SUMMON_JWT}` },
        })
        return resp.json()
}

const getOrCreateUserId: (address: string) => Promise<string> = async (address) => {
    try {
        const body = address.startsWith("addr") ? { address } : { "address": "", "stake_pkh_hex": address }
        const authRes = await fetch(`${SERVICES.USER_SERVICE}/getOrCreateUserId`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {
                "Authorization": `Bearer ${process.env.SUMMON_JWT}`,
                "Content-Type": "application/json",
            },
        })
        if (authRes.status === 200) return await authRes.text()

        throw `Couldn't create a user with address: ${address}`
    }
    catch (err: any) {
        console.log(err)
        throw new Error(err.toString())
    }
}

// We need to create the community directly in the database.
const createNewCommunity = async (prisma: PrismaClient, name: string, description: string, authHeader: string, userAddr: string) => {
    const userId = await getOrCreateUserId(userAddr)
    let managers = await prisma.managers.create({
        data: {
            manager_user_id: userId,
            pollmanager_user_id: undefined,
            subcommunities_manager_user_id: undefined,
            multisig_manager_user_id: undefined,
            multisig_connection_restriction_lvl: undefined,
            pollmanager_connection_restriction_lvl: undefined,
            subcommunities_connection_restriction_lvl: undefined
        }
    })

    if (!managers) throw `Creating community failed because: We could not create required community managers record.`
    let community = await prisma.community.create({
        data: {
            display_name: name,
            description: description,
            profile_photo_url: undefined,
            created_at: new Date(),
            community_managers_id: managers.id,
        }
    })
    if (!community) throw `Creating community failed because: We could not create required community record.`

    await prisma.community_user.create({
        data: {
            community_id: community.id,
            summonuser_id: userId,
        }
    })
    return community.id
}

const convertThresholdsToBigInt = (thresholds: number[]): [BigInt, BigInt, BigInt, BigInt, BigInt] => {
    const l =  thresholds.map(value => BigInt(value.toString())) as unknown;
    return l as [BigInt, BigInt, BigInt, BigInt, BigInt];
}

const handleDaoConfirmation = async (prisma: PrismaClient, theDao: any) => {
    let time = new Date().getTime() - theDao.created_at.getTime()
    if (time < 900000) throw new Error("There is already an unconfirmed dao for this community.")
    let txInfo = await fetchBlockFrost('txs', theDao.confirm_hash);
    if (txInfo && txInfo.block) {
        let blockInfo = await fetchBlockFrost('blocks', txInfo.block);
        if (blockInfo && blockInfo.confirmations && blockInfo.confirmations > 6) {
            await prisma.dao.update({
                where: { id: theDao.id },
                data: { confirmed: true },
            });
        }
    } else if (time > 900000) {
        // Delete community_dao for for the dao.
        await prisma.community_dao.delete({
            where: { dao_id: theDao.id },
        });
        // Delete the dao itself as well, it's not yet confirmed after 15 minutes.
        await prisma.dao.delete({
            where: { id: theDao.id },
        });
    }
}

export const fetchBlockFrost = async (endpoint: string, input: string) => {
    const response = await fetch(`${process.env.BLOCKFROST_URL}/${endpoint}/${input}`, {
        headers: { project_id: process.env.BLOCKFROST_API_KEY || "" },
    });

    if (!response.ok) {
        return undefined;
    }

    return response.json();
}

export const createGovernorEndpoint = async (prisma: PrismaClient, userId: string, authHeader: string, reqBody: CreateGovernorBody) => {
    // Here, before we get into the rest we should check to see if the 
    let communityId = reqBody.communityId
    if (reqBody.communityId == undefined || reqBody.communityId == "") {
        // Create a new community with random name and description.
        const name = getRandomName()
        const description = getRandomDescription()
        const community = await createNewCommunity(prisma, name, description, authHeader, reqBody.address)
        communityId = community
    }
    if (communityId == undefined) throw new Error("Community ID is undefined")
    const community = await prisma.community.findFirst({
        where: {
            id: communityId
        }
    })
    if (!community) throw new Error("Community does not exist")
    // Check to see if there is already a dao for the given community, throw an error if so.
    const communityDao = await prisma.community_dao.findFirst({
        where: {
            community_id: communityId
        }
    })

    if (communityDao) {
        const theDao = await prisma.dao.findFirst({
            where: {
                id: communityDao.dao_id
            }
        })

        if (theDao && theDao.confirmed) {
            throw new Error("There is already a confirmed dao for this community.")
        }

        if (theDao && theDao.created_at) {
            await handleDaoConfirmation(prisma, theDao);
        }
    }

    // Format the incoming request in order to properly create the relevant tx.
    const lucid = await getLucid(reqBody.address, reqBody.utxos)
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash || ""
    if (!cred) throw new Error("No valid credential")

    let utxos = await lucid.wallet.getUtxos()
    if (!utxos || utxos.length === 0) throw new Error("No utxos")
    utxos = [utxos.find((e) => {e.assets['lovelace'] > 5000000}) || utxos[0]]

    const dThresh = convertThresholdsToBigInt(reqBody.thresholds);
    const maxPropPerStake = BigInt(reqBody.maxProposalsPerStake.toString())

    const datum = GOVERNOR_DATUM(dThresh, BigInt(0), reqBody.timingConfig, reqBody.maxWidth, maxPropPerStake)
    if (!datum) throw new Error("Governor Datum not created")

    const scriptParams: ScriptParams = {
        gstOutRef: {
            txOutRefId: utxos[0].txHash,
            txOutRefIdx: utxos[0].outputIndex
        },
        gtClassRef: [reqBody.govTokenPolicy, reqBody.govTokenName],
        maximumCosigners: reqBody.maximumCosigners
    }

    const tx = await createGovernor(lucid, utxos, scriptParams, datum, undefined)

    // Create the entries in the database for scriptparams and an unconfirmed dao.
    const scriptparams = await prisma.scriptparams.create({
        data: { 
            gis_tx_out_ref_id: scriptParams.gstOutRef.txOutRefId,
            gis_tx_out_ref_id_x: scriptParams.gstOutRef.txOutRefIdx,
            gt_class_ref1: scriptParams.gtClassRef[0],
            gt_class_ref2: scriptParams.gtClassRef[1],
            maximum_cosigners: scriptParams.maximumCosigners
        }
    })

    const txHash = tx.toHash()

    const references = await prisma.references.create({
        data: {
            proposalRef: `${txHash}#1`,
            stakeRef: `${txHash}#2`,
        }
    })

    const sc: Credential = { type: "Key", hash: "e1cdd647d7e931bfbe0a81468214dab248be894e898bb01ebe0b646d06"}

    const treasuryAddress = await lucid.utils.validatorToAddress(await getTreasuryValidator(scriptParams), sc)

    const newDao = await prisma.dao.create({
        data: {
            treasury_addr: treasuryAddress,
            scriptparams_id: scriptparams.id,
            references_id: references.id,
            confirm_hash: tx.toHash(),
        }
    })

    const communityConnections = await createDaoCommunityRelations([communityId], newDao.id, userId)

    // Return the tx to the user for signing.
    const sTx = toHex(tx.txComplete.to_bytes())

    return { tx: sTx, communityId: communityId }
}

export const getGovernorData = async (prisma: PrismaClient, communityId: string) => {
    const community = await prisma.community.findFirst({
        where: {
            id: communityId
        }
    })
    if (!community) throw new Error("Community does not exist")
    const communityDao = await prisma.community_dao.findFirst({
        where: {
            community_id: communityId
        }
    })
    if (!communityDao) throw new Error("Community does not have a dao")
    const dao = await prisma.dao.findFirst({
        where: {
            id: communityDao.dao_id
        },
        include: {
            scriptparams: true
        }
    })
    if (!dao) throw new Error("Dao does not exist")
    const scriptParams = dao.scriptparams
    if (!scriptParams) throw new Error("Script params do not exist")
    const passableScriptParams: ScriptParams = {
        gstOutRef: {
            txOutRefId: scriptParams.gis_tx_out_ref_id,
            txOutRefIdx: scriptParams.gis_tx_out_ref_id_x
        },
        gtClassRef: [
            scriptParams.gt_class_ref1,
            scriptParams.gt_class_ref2
        ],
        maximumCosigners: scriptParams.maximum_cosigners
    }
    const governorThread = await getGovernorPolicy(passableScriptParams)
    const lucid = await getLucid(undefined, undefined)
    const govUtxo = await lucid.utxoByUnit(lucid.utils.mintingPolicyToId(governorThread))
    if (!govUtxo) throw new Error("Governor Utxo does not exist")
    const info = deserializeGov(govUtxo.datum!)
    const threshold0 = info.propThresholds.as_list()?.get(0).as_integer()?.to_str()
    const threshold1 = info.propThresholds.as_list()?.get(1).as_integer()?.to_str()
    const threshold2 = info.propThresholds.as_list()?.get(2).as_integer()?.to_str()
    const threshold3 = info.propThresholds.as_list()?.get(3).as_integer()?.to_str()
    const threshold4 = info.propThresholds.as_list()?.get(4).as_integer()?.to_str()
    const authTokenPolicy = await getAuthorityPolicy(passableScriptParams)
    const govInfo = {
        scriptParams: passableScriptParams,
        thresholds: [threshold0, threshold1, threshold2, threshold3, threshold4],
        nextProposalId: info.nextPropId.as_integer()?.to_str(),
        proposalTiming: [
            info.timingConfig.as_list()?.get(0).as_integer()?.to_str(),
            info.timingConfig.as_list()?.get(1).as_integer()?.to_str(),
            info.timingConfig.as_list()?.get(2).as_integer()?.to_str(),
            info.timingConfig.as_list()?.get(3).as_integer()?.to_str(),
            info.timingConfig.as_list()?.get(4).as_integer()?.to_str(),
            info.timingConfig.as_list()?.get(5).as_integer()?.to_str()
        ],
        proposalTxMaxLength: info.maxTimeRange.as_integer()?.to_str(),
        proposalsPerStake: info.maxProposalsPerStake.as_integer()?.to_str(),
        authTokenPolicy: lucid.utils.mintingPolicyToId(authTokenPolicy),
    }
    return govInfo
}