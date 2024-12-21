import { PrismaClient } from '@prisma/client'
import { ScriptParams, getAuthorityPolicy, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, getTreasuryValidator } from '../../resources/plutus.js'
import { Credential, Lucid, OutRef, Script, UTxO, toHex } from 'lucid-cardano'
import { getLucid, getLucidWithCredential } from '../summon-utils/util/sc.js'
import { request } from 'http'

export type DaoSelection = {
    kind: string,
    communityId?: string,
    daoId?: string,
    scriptParams?: ScriptParams
}

export type DaoSelectionInfo = {
    kind: string,
    communityId?: string,
    daoId?: string,
    scriptParams: ScriptParams
}

export type DaoInfo = {
    communityId?: string,
    daoId?: string,
    scriptParams: ScriptParams
}

export type DeployBody = {
    communityId: string,
    type: string,
    address: string,
    utxos: OutRef[],
}

export const getScriptParamsForCommunity = async (prisma: PrismaClient, communityId: string): Promise<{daoScriptParams: ScriptParams, daoId: string}> => {
    let community = await prisma.community.findFirst({
        where: {
            id: communityId
        }
    })
    if (!community) {
        throw "No Community present with id provided."
    }
    let communityDao = await prisma.community_dao.findFirst({
        where: {
            community_id: community.id,
        }
    })
    let daoId = communityDao ? communityDao.dao_id : undefined
    if (!daoId) throw "No dao present with community provided."
    let dao = await prisma.dao.findFirst({
        where: {
            id: daoId
        }
    })

    if (!dao) {
        throw "No dao present with community provided."
    }

    let scriptInfo = await prisma.scriptparams.findFirst({
        where: {
            id: dao.scriptparams_id ? dao.scriptparams_id : ""
        }
    })

    if (!scriptInfo) {
        throw "No script info present with dao provided."
    }

    let daoScriptParams: ScriptParams = {
        gstOutRef: {
            txOutRefId: scriptInfo.gis_tx_out_ref_id ? scriptInfo.gis_tx_out_ref_id : "",
            txOutRefIdx: scriptInfo.gis_tx_out_ref_id_x ? scriptInfo.gis_tx_out_ref_id_x : 0

        },
        gtClassRef: [scriptInfo.gt_class_ref1 ? scriptInfo.gt_class_ref1 : "", scriptInfo.gt_class_ref2 ? scriptInfo.gt_class_ref2 : ""],
        maximumCosigners: scriptInfo.maximum_cosigners ? scriptInfo.maximum_cosigners : 0
    }

    console.log('daoScriptParams', daoScriptParams)

    return { daoScriptParams, daoId }
}


// The following function needs to include daoId if community is provided, and scriptParams if daoid is provided.
// Do we even need a daoId?
export const returnAppropriateInfo = async (prisma: PrismaClient, d: DaoSelection): Promise<DaoInfo> => {
    if (d.kind === "script") {
        if (!d.scriptParams) throw "No script params provided."
        return {
            scriptParams: d.scriptParams
        }
    }
    if (d.scriptParams) {
        return {
            scriptParams: d.scriptParams
        }
    }
    if (d.kind === "community") {
        let community = await prisma.community.findFirst({
            where: {
                id: d.communityId
            }
        })
        if (!community) {
            throw "No Community present with id provided."
        }
        let communityDao = await prisma.community_dao.findFirst({
            where: {
                community_id: community.id
            }
        })
        let daoId = communityDao ? communityDao.dao_id : undefined
        if (!daoId) throw "No dao present with community provided."
        let dao = await prisma.dao.findFirst({
            where: {
                id: daoId
            }
        })

        if (!dao) {
            throw "No dao present with community provided."
        }

        let scriptInfo = await prisma.scriptparams.findFirst({
            where: {
                id: dao.scriptparams_id ? dao.scriptparams_id : ""
            }
        })

        if (!scriptInfo) {
            throw "No script info present with dao provided."
        }

        let scriptParams: ScriptParams = {
            gstOutRef: {
                txOutRefId: scriptInfo.gis_tx_out_ref_id ? scriptInfo.gis_tx_out_ref_id : "",
                txOutRefIdx: scriptInfo.gis_tx_out_ref_id_x ? scriptInfo.gis_tx_out_ref_id_x : 0

            },
            gtClassRef: [scriptInfo.gt_class_ref1 ? scriptInfo.gt_class_ref1 : "", scriptInfo.gt_class_ref2 ? scriptInfo.gt_class_ref2 : ""],
            maximumCosigners: scriptInfo.maximum_cosigners ? scriptInfo.maximum_cosigners : 0
        }

        return {
            communityId: community.id,
            daoId: dao.id,
            scriptParams: scriptParams
        }
    }
    if (d.kind === "dao") {
        let dao = await prisma.dao.findFirst({
            where: {
                id: d.daoId
            }
        })

        if (!dao) {
            throw "No dao present with community provided."
        }

        let scriptInfo = await prisma.scriptparams.findFirst({
            where: {
                id: dao.scriptparams_id ? dao.scriptparams_id : ""
            }
        })

        if (!scriptInfo) {
            throw "No script info present with dao provided."
        }

        let scriptParams: ScriptParams = {
            gstOutRef: {
                txOutRefId: scriptInfo.gis_tx_out_ref_id ? scriptInfo.gis_tx_out_ref_id : "",
                txOutRefIdx: scriptInfo.gis_tx_out_ref_id_x ? scriptInfo.gis_tx_out_ref_id_x : 0

            },
            gtClassRef: [scriptInfo.gt_class_ref1 ? scriptInfo.gt_class_ref1 : "", scriptInfo.gt_class_ref2 ? scriptInfo.gt_class_ref2 : ""],
            maximumCosigners: scriptInfo.maximum_cosigners ? scriptInfo.maximum_cosigners : 0
        }

        return {
            daoId: dao.id,
            scriptParams: scriptParams
        }
    }
    throw "No valid dao selection provided."
}

export const getReferenceUtxo = async (prisma: PrismaClient, lucid: Lucid, communityId: string, type: string) => {
    try {
        const communityDao = await prisma.community_dao.findFirst({
            where: {
                community_id: communityId
            }
        })
        if (!communityDao) throw "No community dao found"
        const dao = await prisma.dao.findFirst({
            where: {
                id: communityDao.dao_id
            },
            include: {
                references: true
            }
        })
        if (!dao || !dao.references) throw "No dao found"
        const references = dao.references
        let referenceString: string | null = null

        switch (type) {
            case "GovernorValidator":
                referenceString = references.governorRef
                break;
            case "GovernorPolicy":
                referenceString = references.governorPol
                break;
            case "ProposalValidator":
                referenceString = references.proposalRef
                break;
            case "ProposalPolicy":
                referenceString = references.proposalPol
                break;
            case "StakeValidator":
                referenceString = references.stakeRef
                break;
            case "StakePolicy":
                referenceString = references.stakePol
                break;
            case "TreasuryValidator":
                referenceString = references.treasuryRef
                break;
            case "TreasuryStakeValidator":
                referenceString = references.treasurySRef
                break;
            case "Auth":
                referenceString = references.authRef
                break;
            case "Manager":
                referenceString = references.managerToken
                break;
            default:
                break;
        }
        if (referenceString == null) return undefined;
        let txHash = referenceString.split("#")[0]
        let outputIndex = parseInt(referenceString.split("#")[1])
        let utxo = await lucid.utxosByOutRef([{txHash, outputIndex}])
        if (utxo.length == 0) return undefined
        return utxo[0]
    } catch (e) {
        console.log(e)
        throw e
    }
}

async function checkReferenceUtxo(prisma: PrismaClient, lucid: Lucid, communityId: string, type: string) {
    const communityDao = await prisma.community_dao.findFirst({
        where: {
            community_id: communityId
        }
    })
    if (!communityDao) throw "No community dao found"
    const dao = await prisma.dao.findFirst({
        where: {
            id: communityDao.dao_id
        },
        include: {
            references: true
        }
    })

    if (!dao || !dao.references) {
        throw new Error("No DAO found for the given community.");
    }

    // Fetch the reference for the given dao
    const reference = dao.references;

    // If no reference found, create a new one
    if (!reference) {
        throw new Error("No reference found for the given DAO.");
    }

    const utxo = await getReferenceUtxo(prisma, lucid, communityId, type)

    // If the utxo exists, throw an error
    if (utxo) {
        throw new Error("Reference UTXO still exists on-chain.");
    }

    return reference;
}


export const deployReferenceUtxo = async (prisma: PrismaClient, body: any) => {
    const requestBody = body as DeployBody
    const lucid = await getLucid(requestBody.address, requestBody.utxos)
    const { daoScriptParams, daoId } = await getScriptParamsForCommunity(prisma, requestBody.communityId)
    const address = await lucid.wallet.address()
    let script: Script | undefined = undefined

    switch (requestBody.type) {
        case "GovernorValidator":
            script = await getGovernorValidator(daoScriptParams)
            break;
        case "GovernorPolicy":
            script = await getGovernorPolicy(daoScriptParams)
            break;
        case "ProposalValidator":
            script = await getProposalValidator(daoScriptParams)
            break;
        case "ProposalPolicy":
            script = await getProposalPolicy(daoScriptParams)
            break;
        case "StakeValidator":
            script = await getStakeValidator(daoScriptParams)
            break;
        case "StakePolicy":
            script = await getStakePolicy(daoScriptParams)
            break;
        case "TreasuryValidator":
            script = await getTreasuryValidator(daoScriptParams)
            break;
        case "TreasuryStakeValidator":
            break;
        case "Auth":
            script = await getAuthorityPolicy(daoScriptParams)
            break;
        case "Manager":
            break;
        default:
            break;
    }
    if (!script) throw "No script found"
    const ad = lucid.utils.getAddressDetails(address)
    const nativeScript = lucid.utils.nativeScriptFromJson({
        'type': 'sig',
        'keyHash': ad.paymentCredential!.hash
    }) 
    const references = await checkReferenceUtxo(prisma, lucid, requestBody.communityId, requestBody.type)
    const sc: Credential = {type: 'Key', hash: 'e1cdd647d7e931bfbe0a81468214dab248be894e898bb01ebe0b646d06'}
    const tx = await lucid.newTx().payToAddressWithData(lucid.utils.validatorToAddress(nativeScript, sc), {scriptRef: script}, { lovelace: 1000000n })
    const txComplete = await tx.complete()
    let referenceUpdate;
    switch (requestBody.type) {
        case "GovernorValidator":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    governorRef: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "GovernorPolicy":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    governorPol: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "ProposalValidator":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    proposalRef: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "ProposalPolicy":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    proposalPol: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "StakeValidator":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    stakeRef: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "StakePolicy":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    stakePol: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "TreasuryValidator":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    treasuryRef: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "TreasuryStakeValidator":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    treasurySRef: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "Auth":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    authRef: `${txComplete.toHash()}#0`
                }
            })
            break;
        case "Manager":
            referenceUpdate = await prisma.references.update({
                where: {
                    id: references.id
                    },
                data: {
                    managerToken: `${txComplete.toHash()}#0`
                }
            })
            break;
        default:
            break;
    }

    let sTx = toHex(txComplete.txComplete.to_bytes())
    return sTx
}