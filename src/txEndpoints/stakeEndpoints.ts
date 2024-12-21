import { community, PrismaClient } from '@prisma/client';
import { getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, ScriptParams } from '../../resources/plutus.js'
import { Blockfrost, C, Credential, Datum, DatumHash, datumJsonToCbor, Lucid, Network, OutRef, Script, ScriptHash, toHex, fromHex, UTxO, utxoToCore, TxComplete, KeyHash, WalletApi } from 'lucid-cardano'
import { deserializeInt, deserializeProposal, deserializeStake, filterUtxosByRef, filterUtxosByRefs, getLucidWithCredential } from '../summon-utils/util/sc.js'
import { createStake, cosignProp, delegateStake, permitVote, retractVote, updateStake, destroyStake, unlockVote } from '../transactions/stakeTransactions.js'
import { bfKey, bfUrl, getLucid } from '../summon-utils/util/sc.js'
import { NO_CREDENTIAL_ERROR, NO_DATUM_FOUND_ERROR, NO_STAKE_FOUND_ERROR, STAKE_ALREADY_FOUND_ERROR, STAKE_IS_LOCKED_ERROR} from '../summon-utils/util/error.js'
import { DaoSelection, getReferenceUtxo, getScriptParamsForCommunity } from './daoSelection.js'
import { MAKE_CREDENTIAL, MAKE_MAYBE } from '../summon-datums/agora/shared.js';
import { getProposalUtxo } from './proposalEndpoints.js';
import { UPDATE_PURE_STAKE_DATUM } from '../summon-datums/agora/stake.js';

type CreateStakeBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    amount: string, // Amount of GT to stake.
    utxos: OutRef[] // User Wallet UTxOs.
}

type UpdateStakeBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    utxo: {txHash: string, index: number}, // Stake UTxO.
    delta: string, // Amount to add or subtract from stake.
    utxos: OutRef[] // User Wallet UTxOs.
}

type DelegateStakeBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    utxo: {txHash: string, index: number}, // Stake UTxO.
    delegateTo: string, // Address to delegate to.
    utxos: OutRef[] // User Wallet UTxOs.
}

type CosignProposalBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    utxo: {txHash: string, index: number}, // Stake UTxO.
    propId: string, // Proposal Id.
    utxos: OutRef[] // User Wallet UTxOs.
}

type ApplyVoteBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    utxos: {txHash: string, outputIndex: number}[], // Stake UTxOs.
    propId: string, // Proposal Id.
    voteResult: number, // Vote result.
    uutxos: OutRef[] // User Wallet UTxOs.
}

type RevokeVoteBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    utxo: {txHash: string, index: number}, // Stake UTxO.
    propLock: {propId: string, propLock: string}, // Proposal Lock.
    utxos: OutRef[] // User Wallet UTxOs.
}

type DestroyStakeBody = {
    address: string, // User CIP-30 Address.
    communityId: string, // Summon Platform CommunityId.
    utxos: {txHash: string, index: number}[], // Stake UTxOs.
    uutxos: OutRef[] // User Wallet UTxOs.
}

const compareStakeOwner = (lucid: Lucid, utxo: UTxO, owner: string[]) => {
    try {
        const stake = utxo.datum
        if (!stake) throw "NO DATUM FOUND ON STAKE UTXO"
        const stDatum = C.PlutusData.from_bytes(fromHex(stake)).as_list() // Extract to function
        if (!stDatum) throw ""
        let ownerCred = stDatum.get(1)
        if (ownerCred == undefined) throw "No owner credential"
        for (let o of owner) {
            const aDetails = lucid.utils.getAddressDetails(o)
            if (!aDetails.paymentCredential) throw "No payment credential"
            const compareCred = MAKE_CREDENTIAL(aDetails.paymentCredential)
            if (toHex(compareCred.to_bytes()) == toHex(ownerCred.to_bytes())) {
                return true
            }
        }
        return false
    } catch (e) {
        return false
    }
}

const compareStakeDelegatee = (lucid: Lucid, utxo: UTxO, delegatee: string[]) => {
    try {
        const stake = utxo.datum
        if (!stake) throw "NO DATUM FOUND ON STAKE UTXO"
        const stDatum = C.PlutusData.from_bytes(fromHex(stake)).as_list() // Extract to function
        if (!stDatum) throw ""
        let maybeDelegate = stDatum.get(2)
        if (maybeDelegate == undefined) throw "No maybeDelegate present"
        for (let d of delegatee) {
            const aDetails = lucid.utils.getAddressDetails(d)
            if (!aDetails.paymentCredential) throw "No payment credential"
            const compareCred = MAKE_MAYBE(MAKE_CREDENTIAL(aDetails.paymentCredential))
            if (toHex(compareCred.to_bytes()) == toHex(maybeDelegate.to_bytes())) {
                return true
            }
        }
        return false
    } catch (e) {
        return false
    }
}

const processPropLocks = (propLocks: any) => {
    let propLockReturnList = []
    const propLockLen = propLocks.as_list()?.len() || 0 // propLocks.as_list().len()
    for (let i = 0; i < propLockLen; i++) {
        const element = propLocks.as_list()?.get(i)
        if (element == undefined) throw "No element in propLocks"
        const propLock = element.as_list()
        if (propLock == undefined) throw "No propLock in propLocks"
        const propLockType = propLock.get(0)
        if (propLockType == undefined) throw "No propLockType in propLock"
        const propLockValue = propLock.get(1)
        if (propLockValue == undefined) throw "No propLockValue in propLock"
        const type = propLockValue.as_constr_plutus_data()?.alternative()?.to_str()
        if (type == "0") {
            propLockReturnList.push({propId: propLockType.as_integer()?.to_str(), propLock: "Created"})
        } else if (type == "1") {
            const result = propLockValue.as_constr_plutus_data()?.data()?.get(0).as_integer()?.to_str() || "NAN"
            propLockReturnList.push({propId: propLockType.as_integer()?.to_str(), propLock: `Voted-${result}`})
        } else if (type == "2") {
            propLockReturnList.push({propId: propLockType.as_integer()?.to_str(), propLock: "Cosigned"})
        } else {
            propLockReturnList.push({propId: propLockType.as_integer()?.to_str(), propLock: "Unknown"})
        }
    }
    return propLockReturnList
}

export const getAllUserStakes = async (prisma: PrismaClient, communityId: string, userAddresses: string[]) => {
    const { daoScriptParams }  = await getScriptParamsForCommunity(prisma, communityId)
    if (userAddresses.length < 1) throw "No user addresses provided"
    const lucid = await getLucid(userAddresses[0])
    const stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))
    const stakeUtxos = await lucid.utxosAt(stakeAddress)
    let stakedAmount = BigInt(0)
    let userClaimedStakeUtxos = []
    const stakedAsset = daoScriptParams.gtClassRef[0] + daoScriptParams.gtClassRef[1]
    for (let i = 0; i < stakeUtxos.length; i++) {
        const stake = stakeUtxos[i]
        stakedAmount = stakedAmount + stake.assets[stakedAsset]
        const stakeDeserialized = deserializeStake(stake.datum || "")
        const delegatedTo = stakeDeserialized.maybeDelegate.as_constr_plutus_data()?.alternative().to_str()
        if (compareStakeOwner(lucid, stake, userAddresses)) {
            userClaimedStakeUtxos.push({
                txHash: stake.txHash,
                outputIndex: stake.outputIndex,
                relation: "owner",
                delegated: delegatedTo == "0" ? true : false,
                amount: deserializeInt(stakeDeserialized.stakedGt),
                locks: processPropLocks(stakeDeserialized.propLocks)
            })
        }
        if (compareStakeDelegatee(lucid, stake, userAddresses)) {
            userClaimedStakeUtxos.push({
                txHash: stake.txHash,
                outputIndex: stake.outputIndex,
                relation: "delegatee",
                delegated: delegatedTo == "0" ? true : false,
                amount: deserializeInt(stakeDeserialized.stakedGt),
                locks: processPropLocks(stakeDeserialized.propLocks)
            })
        }
    }
    const stakedAmountString = stakedAmount.toString()
    return { userClaimedStakeUtxos, stakedAmountString }
}

export const createStakeEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    console.log(reqBod)
    const reqBody: CreateStakeBody = reqBod as CreateStakeBody
    const lucid = await getLucid(reqBody.address, reqBody.utxos)
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    if (cred == "") throw NO_CREDENTIAL_ERROR
    let {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    console.log("About to create Tx.")
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakePolicy')
    
    let tx = await createStake(lucid, daoScriptParams, BigInt(reqBody.amount), readFromStakeUtxo)
    console.log("Created tx")

    let sTx = toHex(tx.txComplete.to_bytes())
    
    return sTx
}

export const updateStakeEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    const reqBody: UpdateStakeBody = reqBod as UpdateStakeBody
    const lucid = await getLucid(reqBody.address, reqBody.utxos)
    const {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    let stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    if (cred == "") throw NO_CREDENTIAL_ERROR;
    
    let scriptUtxos = await lucid.utxosAt(stakeAddress)
    scriptUtxos = filterUtxosByRef(scriptUtxos, reqBody.utxo.txHash, reqBody.utxo.index, undefined)
    if (scriptUtxos.length < 1) throw ""
    let scriptUtxo = scriptUtxos[0]
    if (!scriptUtxo.datum) {
        throw "The chosen scriptUTxO does not have a datum present on it."
    }
    console.log("Got Datum Info.")

    const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(scriptUtxo.datum)
    let locksAsList = C.PlutusList.from_bytes(propLocks.to_bytes())
    let stakedGtNum = BigInt(C.BigInt.from_bytes(stakedGt.to_bytes()).to_str())
    if (locksAsList.len() > 0) throw STAKE_IS_LOCKED_ERROR
    console.log("Passed lock check.")
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakeValidator')

    let tx = await updateStake(lucid, daoScriptParams, stakedGtNum + BigInt(reqBody.delta), scriptUtxo, readFromStakeUtxo)
    console.log("We built the tx.")

    let sTx = toHex(tx.txComplete.to_bytes())
    
    return {tx: sTx}
}

export const delegateStakeEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    const reqBody: DelegateStakeBody = reqBod as DelegateStakeBody
    const lucid = await getLucid(reqBody.address, reqBody.utxos)
    let {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    let stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))

    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    if (cred == "") {
        console.log("There isn't a credential on the user address")
        throw NO_CREDENTIAL_ERROR;
    }

    let scriptUtxos = await lucid.utxosAt(stakeAddress)
    scriptUtxos = filterUtxosByRef(scriptUtxos, reqBody.utxo.txHash, reqBody.utxo.index, undefined)
    if (scriptUtxos.length < 1) throw ""
    let scriptUtxo = scriptUtxos[0]
    if (!scriptUtxo.datum) {
        throw "The chosen scriptUTxO does not have a datum present on it."
    }

    const {stakedGt, ownerCred, maybeDelegate, propLocks} = deserializeStake(scriptUtxo.datum)
    let locksAsList = C.PlutusList.from_bytes(propLocks.to_bytes())
    let stakedGtNum = BigInt(C.BigInt.from_bytes(stakedGt.to_bytes()).to_str())

    let icredential: Credential | undefined = undefined;
    if (reqBody.delegateTo != "") {
        const credential = lucid.utils.getAddressDetails(reqBody.delegateTo).paymentCredential
        icredential = credential
    }
    console.log("About to delegate stake.")
    console.log("Delegating to", icredential)
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakeValidator')
    let {tx, datum, datumHash} = await delegateStake(lucid, daoScriptParams, scriptUtxo.datum, icredential, scriptUtxo, readFromStakeUtxo)

    let sTx = toHex(tx.txComplete.to_bytes())
    
    return {tx: sTx, datumHash: datumHash}
}

export const cosignEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    const reqBody: CosignProposalBody = reqBod as CosignProposalBody
    const lucid = await getLucid(reqBody.address, reqBody.utxos)
    let {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    let stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    const putxo = (await getProposalUtxo(lucid, prisma, reqBody.communityId, reqBody.propId)).theProposal
    if (cred == "") throw NO_CREDENTIAL_ERROR;

    let scriptUtxos = await lucid.utxosAt(stakeAddress)
    scriptUtxos = filterUtxosByRef(scriptUtxos, reqBody.utxo.txHash, reqBody.utxo.index, undefined)
    if (scriptUtxos.length < 1) throw ""
    let scriptUtxo = scriptUtxos[0]
    if (!scriptUtxo.datum) {
        throw "The chosen scriptUTxO does not have a datum present on it."
    }

    let proposalDatum = putxo.datum
    if (!proposalDatum) {
        console.log("The proposal UTxO has no inline datum.")
        throw ""
    }
    let stakeDatum = scriptUtxo.datum

    console.log(proposalDatum)
    console.log(stakeDatum)
    const readFromProposalUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'ProposalValidator')
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakeValidator')

    let {tx} = await cosignProp(lucid, daoScriptParams, stakeDatum, proposalDatum, scriptUtxo, putxo, readFromStakeUtxo, readFromProposalUtxo)

    let sTx = toHex(tx.txComplete.to_bytes())
    
    return {tx: sTx}
}

export const voteEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    const reqBody: ApplyVoteBody = reqBod as ApplyVoteBody
    const lucid = await getLucid(reqBody.address, reqBody.uutxos)
    let {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    let stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))
    const putxo = (await getProposalUtxo(lucid, prisma, reqBody.communityId, reqBody.propId)).theProposal
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    if (cred == "") throw NO_CREDENTIAL_ERROR;

    let scriptUtxos = await lucid.utxosByOutRef(reqBody.utxos)
    if (scriptUtxos.length < 1) throw "There are no UTxOs present with the txHash and outputIndex provided."
    let correctUtxo = scriptUtxos[0]
    console.log('expected stake addr', stakeAddress)
    console.log('actual utxo addr', correctUtxo.address)

    const readFromProposalUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'ProposalValidator')
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakeValidator')

    let {tx} = await permitVote(lucid, daoScriptParams, scriptUtxos, putxo, BigInt(reqBody.voteResult), readFromStakeUtxo, readFromProposalUtxo)

    let sTx = toHex(tx.txComplete.to_bytes())
    
    return {tx: sTx}

}

export const revokeVoteEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    const reqBody: RevokeVoteBody = reqBod as RevokeVoteBody
    const lucid = await getLucid(reqBody.address, reqBody.utxos)
    let {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    let stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))
    const putxo = (await getProposalUtxo(lucid, prisma, reqBody.communityId, reqBody.propLock.propId)).theProposal
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    if (cred == "") throw NO_CREDENTIAL_ERROR;

    let scriptUtxos = await lucid.utxosByOutRef([{txHash: reqBody.utxo.txHash, outputIndex: reqBody.utxo.index}])
    if (scriptUtxos.length < 1) throw ""
    let scriptUtxo = scriptUtxos[0]
    if (!scriptUtxo.datum) {
        throw "The chosen scriptUTxO does not have a datum present on it."
    }

    // Here we have the stake UTxO and the proposal UTxO.
    // Now we must check if the proposal is finished, if it is finished, we can remove all locks.
    const proposalDatum = putxo.datum
    if (!proposalDatum) {
        console.log("The proposal UTxO has no inline datum.")
        throw ""
    }
    const proposalDeserialized = deserializeProposal(proposalDatum)
    const proposalState = proposalDeserialized.status.as_integer()?.to_str()
    const proposalFinished = proposalState == "3" || proposalState == "2"
    let tx: TxComplete | undefined;

    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakeValidator')
    const readFromProposalUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'ProposalValidator')

    if (proposalFinished) {
        // If the proposal is finished, we can remove all locks - no need to modify proposal..?
        console.log("The proposal has finished or is executing")
        tx = (await unlockVote(lucid, daoScriptParams, [scriptUtxo], putxo, readFromStakeUtxo, readFromProposalUtxo)).tx
    } else {
        // If the proposal is not finished, we can only remove voting locks.
        // If we are removing voting locks. 
        console.log("The proposal has not finished with voting")
        tx = (await retractVote(lucid, daoScriptParams, [scriptUtxo], putxo, readFromStakeUtxo, readFromProposalUtxo)).tx
    }
    if (!tx || !tx.txComplete) throw "No tx or tx.txComplete"

    let sTx = toHex(tx.txComplete.to_bytes())
    
    return {tx: sTx}
}

export const destroyStakeEndpoint = async (prisma: PrismaClient, reqBod: any) => {
    const reqBody: DestroyStakeBody = reqBod as DestroyStakeBody
    const lucid = await getLucid(reqBody.address, reqBody.uutxos)
    let {daoScriptParams} = await getScriptParamsForCommunity(prisma, reqBody.communityId)
    let stakeAddress = lucid.utils.validatorToAddress(await getStakeValidator(daoScriptParams))
    const aDetails = lucid.utils.getAddressDetails(reqBody.address)
    const cred = aDetails.paymentCredential?.hash ? aDetails.paymentCredential.hash : ""
    if (cred == "") throw NO_CREDENTIAL_ERROR;
    console.log("About to destroy stake.")

    let scriptUtxos = await lucid.utxosByOutRef(reqBody.utxos.map((utxo) => {return {txHash: utxo.txHash, outputIndex: utxo.index}}))
    if (scriptUtxos.length < 1) throw ""
    const readFromStakeUtxo = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakeValidator')
    const readFromStakeMint = await getReferenceUtxo(prisma, lucid, reqBody.communityId, 'StakePolicy')

    console.log("entering destroyStake")
    let tx = await destroyStake(lucid, daoScriptParams, scriptUtxos, readFromStakeUtxo, readFromStakeMint)
    let sTx = toHex(tx.txComplete.to_bytes())
    return { tx: sTx }
}