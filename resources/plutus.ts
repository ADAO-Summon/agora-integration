import { C, Constr, Data, Script, SpendingValidator, applyParamsToScript, fromHex, toHex } from 'lucid-cardano';
import { governorPolicyRaw, governorMutationRaw, stakePolicyRaw, stakeScriptRaw, proposalPolicyRaw, proposalScriptRaw, treasuryScriptRaw, authorityPolicyRaw, governorScriptRaw, treasurySpendRaw } from './plutusRaw.js';
import { getLucid } from '../src/summon-utils/util/sc.js'

const lucid = await getLucid()

type ScriptParams = {
    gstOutRef: {
        txOutRefId: string,
        txOutRefIdx: number
    },
    gtClassRef: [string, string],
    maximumCosigners: number,
}

const getStakePolicy = async (scriptParams: ScriptParams) : Promise<Script> => {
    let preScript = stakePolicyRaw

    let application = C.PlutusList.new()
    let internalApplication = C.PlutusList.new()
    internalApplication.add(C.PlutusData.new_bytes(fromHex(scriptParams.gtClassRef[0])))
    internalApplication.add(C.PlutusData.new_bytes(fromHex(scriptParams.gtClassRef[1])))
    application.add(C.PlutusData.new_list(internalApplication))

    let newlyApplied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))

    let fullyApplied = toHex(newlyApplied.to_bytes())
    return { 'type': 'PlutusV2', 'script': fullyApplied };
}

const getGovernorPolicy = async (scriptParams: ScriptParams) : Promise<Script> => {
    let preScript = governorPolicyRaw

    const application = C.PlutusList.new()

    const list = C.PlutusList.new()
    const innerList = C.PlutusList.new()
    innerList.add(C.PlutusData.new_bytes(fromHex(scriptParams.gstOutRef.txOutRefId)))
    const constr = C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("0"), innerList))

    list.add(constr)
    list.add(C.PlutusData.new_integer(C.BigInt.from_str(scriptParams.gstOutRef.txOutRefIdx.toString())))

    const internalApplication2 = C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("0"), list))

    application.add(internalApplication2)

    let applied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))

    return { 'type': 'PlutusV2', 'script': toHex(applied.to_bytes()) };
}

const getProposalPolicy = async (scriptParams: ScriptParams) : Promise<Script> => {
    const governorPolicy = lucid.utils.mintingPolicyToId(await getGovernorPolicy(scriptParams))

    const preScript = proposalPolicyRaw

    let application = C.PlutusList.new()
    let internalApplication = C.PlutusList.new()
    internalApplication.add(C.PlutusData.new_bytes(fromHex(governorPolicy)))
    internalApplication.add(C.PlutusData.new_bytes(fromHex("")))
    application.add(C.PlutusData.new_list(internalApplication))

    let newlyApplied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))

    return { 'type': 'PlutusV2', 'script': toHex(newlyApplied.to_bytes()) };
}

const getAuthorityPolicy = async (scriptParams: ScriptParams) : Promise<Script> => {
    const governorPolicy = lucid.utils.mintingPolicyToId(await getGovernorPolicy(scriptParams))

    const preScript = authorityPolicyRaw

    let application = C.PlutusList.new()
    let internalApplication = C.PlutusList.new()
    internalApplication.add(C.PlutusData.new_bytes(fromHex(governorPolicy)))
    internalApplication.add(C.PlutusData.new_bytes(fromHex("")))
    application.add(C.PlutusData.new_list(internalApplication))

    let newlyApplied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))

    return { 'type': 'PlutusV2', 'script': toHex(newlyApplied.to_bytes()) };
}

const getTreasuryValidator = async (scriptParams: ScriptParams) : Promise<Script> => {
    const authToken = await getAuthorityPolicy(scriptParams)
    const authTokenId = lucid.utils.mintingPolicyToId(authToken)
    let preScript = treasuryScriptRaw

    let application = C.PlutusList.new()
    application.add(C.PlutusData.new_bytes(fromHex(authTokenId)))

    let applied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))
    return { 'type': 'PlutusV2', 'script': toHex(applied.to_bytes()) };
}

const getStakeValidator = async (scriptParams: ScriptParams) : Promise<Script> => {
    const stakeSymbol = lucid.utils.mintingPolicyToId(await getStakePolicy(scriptParams))
    const proposalSymbol = lucid.utils.mintingPolicyToId(await getProposalPolicy(scriptParams))
    let scriptString = stakeScriptRaw

    let application = C.PlutusList.new()
    let internalBytes = C.PlutusData.new_bytes(fromHex(stakeSymbol))
    let internalAC1 = C.PlutusList.new()
    internalAC1.add(C.PlutusData.new_bytes(fromHex(proposalSymbol)))
    internalAC1.add(C.PlutusData.new_bytes(fromHex("")))
    let internalAC2 = C.PlutusList.new()
    internalAC2.add(C.PlutusData.new_bytes(fromHex(scriptParams.gtClassRef[0])))
    internalAC2.add(C.PlutusData.new_bytes(fromHex(scriptParams.gtClassRef[1])))
    application.add(internalBytes)
    application.add(C.PlutusData.new_list(internalAC1))
    application.add(C.PlutusData.new_list(internalAC2))

    let newlyApplied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(scriptString)))
    
    let fullyApplied = toHex(newlyApplied.to_bytes())

    return { 'type': 'PlutusV2', 'script': fullyApplied };
}

const getGovernorValidator = async (scriptParams: ScriptParams) : Promise<Script> => { // It's odd that this one works?
    const stakeSymbol = lucid.utils.mintingPolicyToId(await getStakePolicy(scriptParams))
    const stakeValidator = lucid.utils.validatorToScriptHash(await getStakeValidator(scriptParams))
    const govSymbol = lucid.utils.mintingPolicyToId(await getGovernorPolicy(scriptParams))
    const proposalSymbol = lucid.utils.mintingPolicyToId(await getProposalPolicy(scriptParams))
    const proposalValHash = lucid.utils.validatorToScriptHash(await getProposalValidator(scriptParams))
    const authSymbol = lucid.utils.mintingPolicyToId(await getAuthorityPolicy(scriptParams))
    const preScript = governorScriptRaw

    let application = C.PlutusList.new()
    let internalBytes0 = C.PlutusData.new_bytes(fromHex(proposalValHash))
    let internalAC1 = C.PlutusList.new()
    internalAC1.add(C.PlutusData.new_bytes(fromHex(stakeSymbol)))
    internalAC1.add(C.PlutusData.new_bytes(fromHex(stakeValidator)))
    let internalBytes1 = C.PlutusData.new_bytes(fromHex(govSymbol))
    let internalBytes2 = C.PlutusData.new_bytes(fromHex(proposalSymbol))
    let internalBytes3 = C.PlutusData.new_bytes(fromHex(authSymbol))
    application.add(internalBytes0)
    application.add(C.PlutusData.new_list(internalAC1))
    application.add(internalBytes1)
    application.add(internalBytes2)
    application.add(internalBytes3)

    let newlyApplied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))

    return { 'type': 'PlutusV2', 'script': toHex(newlyApplied.to_bytes())};
}

const getProposalValidator = async (scriptParams: ScriptParams) : Promise<Script> => {
    const preScript = proposalScriptRaw
    const stakePolicyId = lucid.utils.mintingPolicyToId(await getStakePolicy(scriptParams))
    const stakeName = lucid.utils.validatorToScriptHash(await getStakeValidator(scriptParams))
    const govPolicyId = lucid.utils.mintingPolicyToId(await getGovernorPolicy(scriptParams))
    const propPolicyId = lucid.utils.mintingPolicyToId(await getProposalPolicy(scriptParams))

    let application = C.PlutusList.new()
    let internalBytes1 = C.PlutusData.new_bytes(fromHex(govPolicyId))
    let internalBytes2 = C.PlutusData.new_bytes(fromHex(propPolicyId))
    let internalAC1 = C.PlutusList.new()
    internalAC1.add(C.PlutusData.new_bytes(fromHex(stakePolicyId)))
    internalAC1.add(C.PlutusData.new_bytes(fromHex(stakeName)))
    application.add(C.PlutusData.new_list(internalAC1))
    application.add(internalBytes1)
    application.add(internalBytes2)
    application.add(C.PlutusData.new_integer(C.BigInt.from_str(scriptParams.maximumCosigners.toString())))

    let newlyApplied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))

    return { 'type': 'PlutusV2', 'script': toHex(newlyApplied.to_bytes()) };
}

const noOp = async (scriptParams: ScriptParams): Promise<Script> => {
    const authToken = await getAuthorityPolicy(scriptParams)
    const authTokenId = lucid.utils.mintingPolicyToId(authToken)
    const preScript = "59031d59031a010000323232323232323232323232323232222232323232533300e3370e9001001099192999808299911998090010008a50325333011001100113301549013373696e676c65417574686f72697479546f6b656e4275726e65643a204d757374206275726e2065786163746c79203120474154000013370e660160146eacc058c8c060c060c060004c05c004c8cdc0a400000290010992999808800880089980aa49254f6e6c79206f6e6520474154206d7573742065786973742061742074686520696e70757473000013370e664466602844466a666030002244a0022644460040066464466002006004603a004603600246002446664e0088004c014008cc0180140044c920004988c00c0040048c94ccc048c8cccccc040060070dd48069bab3019301a001232323253330173370e9000001099299980c000880089980e24937617574686f72697479546f6b656e7356616c6964496e3a2047415420696e636f72726563746c79206c69766573206174205075624b6579000014a02944c07c008c068004dd5180d180e180d0010a51301a00113300d00c37566030603260340022a6602c9201355768696c6520636f756e74696e67204741547320617420696e707574733a20616c6c2047415473206d7573742062652076616c69640016323018301900130190013758602c00290010a4c2a66028920128412073696e676c6520617574686f7269747920746f6b656e20686173206265656e206275726e656400163017301500530140011533012491245061747465726e206d61746368696e67206661696c75726520696e205465726d436f6e7400163016002301100137546022602400260240020024466666600601601e6ea40080048ccc02088cdc01bad301200200148000dd58008a40004444666600a6600c0080040024644460040066008002244a0024600a44a666010002244a002266600660160024446004006260046018002444a66600866ebc008c00c004488c00800c48940055cd1118019129998030008801899802180480098011805000919180111980100100091801119801001000aab9f5738aae755d0aba2230023754002aae79"
    let application = C.PlutusList.new()
    application.add(C.PlutusData.new_bytes(fromHex(authTokenId)))
    let applied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))
    return { 'type': 'PlutusV2', 'script': toHex(applied.to_bytes()) };
}

const mutateGovernor = async (scriptParams: ScriptParams): Promise<Script> => {
    const preScript = governorMutationRaw
    const authToken = await getAuthorityPolicy(scriptParams)
    const authTokenId = lucid.utils.mintingPolicyToId(authToken)
    const govPolicyId = lucid.utils.mintingPolicyToId(await getGovernorPolicy(scriptParams))
    const govVal = lucid.utils.validatorToScriptHash(await getGovernorValidator(scriptParams))

    let application = C.PlutusList.new()
    application.add(C.PlutusData.new_bytes(fromHex(govVal)))
    application.add(C.PlutusData.new_bytes(fromHex(govPolicyId)))
    application.add(C.PlutusData.new_bytes(fromHex(authTokenId)))
    let applied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))
    return { 'type': 'PlutusV2', 'script': toHex(applied.to_bytes()) };
}

const spendFromTreasury = async (scriptParams: ScriptParams): Promise<Script> => {
    const authToken = await getAuthorityPolicy(scriptParams)
    const authTokenId = lucid.utils.mintingPolicyToId(authToken)
    const preScript = treasurySpendRaw

    let application = C.PlutusList.new()
    application.add(C.PlutusData.new_bytes(fromHex(authTokenId)))
    let applied = C.apply_params_to_plutus_script(application, C.PlutusScript.from_bytes(fromHex(preScript)))
    return { 'type': 'PlutusV2', 'script': toHex(applied.to_bytes()) };
}

export {mutateGovernor, getStakePolicy, getStakeValidator, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getAuthorityPolicy, getTreasuryValidator, noOp, spendFromTreasury, ScriptParams};