// Define test for each endpoint.
import {
    Assets,
    Blockfrost,
    C,
    Data,
    Datum,
    DatumHash,
    Emulator,
    Credential,
    fromHex,
    fromText,
    generatePrivateKey,
    getAddressDetails,
    Lucid,
    OutputData,
    Script,
    ScriptHash,
    toUnit,
    toHex,
    TxComplete,
    TxHash,
} from "lucid-cardano";
import { createGovernor } from './transactions/governorTransactions.js';
import { createStake, updateStake, destroyStake, delegateStake, permitVote, retractVote, cosignProp, unlockVote } from './transactions/stakeTransactions.js';
import { prepareEffects } from './txEndpoints/proposalEndpoints.js';
import { createProposal, advanceProposal } from './transactions/proposalTransactions.js';
import { ScriptParams, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, noOp, spendFromTreasury, getTreasuryValidator, getAuthorityPolicy, mutateGovernor } from '../resources/plutus.js';
import { GOVERNOR_DATUM, GOVERNOR_UPDATE_DATUM } from './summon-datums/agora/governor.js';
import { MAKE_TREASURY_WITHDRAWAL } from "./summon-datums/agora/shared.js";
import { GovernorEffect, mutateGovernorTx, spendFromTreasuryTx } from "./transactions/effectTransactions.js";
import { deserializeGov } from "./summon-utils/util/sc.js";
import * as fs from 'fs';

console.log("generating keys")
const privateKey0 = generatePrivateKey();
const privateKey1 = generatePrivateKey();
const privateKey2 = generatePrivateKey();
const privateKey3 = generatePrivateKey();
const privateKey4 = generatePrivateKey();
const privateKey5 = generatePrivateKey();
const privateKey6 = generatePrivateKey();
const privateKey7 = generatePrivateKey();
const privateKey8 = generatePrivateKey();
const privateKey9 = generatePrivateKey();
  
console.log("generating addresses")
const address0 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey0).wallet.address();
const address1 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey1).wallet.address();
const address2 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey2).wallet.address();
const address3 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey3).wallet.address();
const address4 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey4).wallet.address();
const address5 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey5).wallet.address();
const address6 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey6).wallet.address();
const address7 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey7).wallet.address();
const address8 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey8).wallet.address();
const address9 = await (await Lucid.new(undefined, "Custom"))
    .selectWalletFromPrivateKey(privateKey9).wallet.address();

let lucid = (await Lucid.new(undefined, "Custom"))
  
console.log("preparing native script")
const { paymentCredential } = getAddressDetails(address0);

// Here we want to have an emulator that pays each of the 10 addresses 100 ADA
console.log("Emulator being created.")
const emulator = new Emulator(
    [
        { address: address0, assets: { ['lovelace']: 100000000000n } },
        { address: address1, assets: { ['lovelace']: 100000000n } },
        { address: address2, assets: { ['lovelace']: 100000000n } },
        { address: address3, assets: { ['lovelace']: 100000000n } },
        { address: address4, assets: { ['lovelace']: 100000000n } },
        { address: address5, assets: { ['lovelace']: 100000000n } },
        { address: address6, assets: { ['lovelace']: 100000000n } },
        { address: address7, assets: { ['lovelace']: 100000000n } },
        { address: address8, assets: { ['lovelace']: 100000000n } }
    ]
);

console.log("Establishing lucid with emulator")
lucid = await Lucid.new(emulator);
lucid.selectWalletFromPrivateKey(privateKey0);

emulator.awaitBlock(1);

const nativeScript = lucid.utils.nativeScriptFromJson({
    type: "all",
    scripts: [
        {
            type: "sig",
            keyHash: paymentCredential?.hash,
        }
    ]
})

const policy = await lucid.utils.mintingPolicyToId(nativeScript);

// Mint Governance Token
console.log("Minting gov token with", address0)
console.log("owner utxos:", await lucid.utxosAt(address0))
const mintTx = await (await (await lucid.newTx()
    .payToAddress(address0, { [policy]: 2000000000000n })
    .mintAssets({ [policy]: 2000000000000n }) //, Data.void())
    .attachMintingPolicy(nativeScript)
    .complete()).sign().complete()).submit();

emulator.awaitBlock(1);

// Search for utxo from previous transaction, use it in the scriptParams.
let userUtxos = await lucid.utxosAt(address0);
//let initUtxo = await lucid.utxosByOutRef([{txHash: mintTx, outputIndex: 0}])
userUtxos = userUtxos.filter(utxo => (utxo.txHash !== mintTx || utxo.outputIndex !== 0))
let initUtxo = userUtxos[0]

console.log("initUtxo:", initUtxo)
console.log("utxosAt", await lucid.utxosAt(address0))

// Create Script Params
const scriptParams: ScriptParams = {
    gstOutRef: {
        txOutRefId: initUtxo.txHash,
        txOutRefIdx: initUtxo.outputIndex
    },
    gtClassRef: [policy, ""],
    maximumCosigners: 5
}

// Create Governor
let effectDat: GovernorEffect = {
    thresholds: [100000000n, 1n, 100000n, 100000n, 100000n],
    propId: 2n,
    propTimings: [new Date(600000), new Date(700000), new Date(700000), new Date(86400000), new Date(1000), new Date(86400000)],
    newProposalValidLength: new Date(1200000),
    proposalsPerStake: 10n,
    newThresholds: [100000000n, 1n, 100000n, 100000n, 100000n],
    newPropTimings: [new Date(600000), new Date(700000), new Date(700000), new Date(86400000), new Date(1000), new Date(86400000)],
    newNewProposalValidLength: new Date(1200000),
    newProposalsPerStake: 10n
}
let initialGovernorDatum = GOVERNOR_DATUM(effectDat.thresholds, 0n, effectDat.propTimings, effectDat.newProposalValidLength, effectDat.proposalsPerStake)
// GOVERNOR_DATUM([100000000n, 1n, 100000n, 100000n, 100000n], 0n, [new Date(600000), new Date(700000), new Date(700000), new Date(86400000), new Date(1000), new Date(86400000)], new Date(1200000), 10n)
let tx0 = await createGovernor(lucid, [initUtxo], scriptParams, initialGovernorDatum, emulator)
let txHash0 = await (await tx0.sign().complete()).submit()
console.log("Governor created")
emulator.awaitBlock(1);
let utxo0 = await lucid.utxosByOutRef([{txHash: txHash0, outputIndex: 0}])

// Deploy scripts
const deploymentScript = lucid.utils.validatorToAddress(lucid.utils.nativeScriptFromJson({
    "type": "all",
    "scripts": []
}))
const governorValidator = await getGovernorValidator(scriptParams)
const stakeValidator = await getStakeValidator(scriptParams)
const proposalValidator = await getProposalValidator(scriptParams)
const proposalPolicy = await getProposalPolicy(scriptParams)

let dist1 = await (await (await lucid.newTx()
    .payToAddressWithData(deploymentScript, { scriptRef: stakeValidator}, {['lovelace']: 2000000n})
    .complete()).sign().complete()).submit()
emulator.awaitBlock(1)
console.log("Deployed scripts (0)")

let dist11 = await (await (await lucid.newTx()
    .payToAddressWithData(deploymentScript, { scriptRef: governorValidator}, {['lovelace']: 2000000n})
    .complete()).sign().complete()).submit()
emulator.awaitBlock(1)


let govValidatorRef = await lucid.utxosByOutRef([{txHash: dist11, outputIndex: 0}])
let stakeValidatorRef = await lucid.utxosByOutRef([{txHash: dist1, outputIndex: 0}])
console.log("Deployed scripts (1)")

let dist2 = await (await (await lucid.newTx()
    .payToAddressWithData(deploymentScript, { scriptRef: proposalValidator }, {['lovelace']: 2000000n})
    .complete()).sign().complete()).submit()
emulator.awaitBlock(1)
let proposalValidatorRef = await lucid.utxosByOutRef([{txHash: dist2, outputIndex: 0}])
console.log("Deployed scripts (2)")

let dist3 = await (await (await lucid.newTx()
    .payToAddressWithData(deploymentScript, { scriptRef: proposalPolicy }, {['lovelace']: 2000000n})
    .complete()).sign().complete()).submit()
emulator.awaitBlock(1);
let proposalPolicyRef = await lucid.utxosByOutRef([{txHash: dist3, outputIndex: 0}])
console.log("Deployed scripts (3)")

// Give other users some gov tokens
let dist4 = await (await (await lucid.newTx()
    .payToAddress(address1, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address2, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address3, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address4, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address5, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address6, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address7, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .payToAddress(address8, { ['lovelace']: 1000000n, [policy]: 200000000n })
    .complete()).sign().complete()).submit()
emulator.awaitBlock(1);
console.log("Generated tokens")

// Create Stake(s)
let tx1 = await createStake(lucid, scriptParams, 101000000n, undefined, emulator)
let txHash1 = await (await tx1.sign().complete()).submit()
console.log("Stake (address0) created")

lucid.selectWalletFromPrivateKey(privateKey1);
let tx2 = await createStake(lucid, scriptParams, 100000000n, undefined, emulator)
let txHash2 = await (await tx2.sign().complete()).submit()

lucid.selectWalletFromPrivateKey(privateKey2);
let tx22 = await createStake(lucid, scriptParams, 100000000n, undefined, emulator)
let txHash22 = await (await tx22.sign().complete()).submit()

lucid.selectWalletFromPrivateKey(privateKey3);
let tx23 = await createStake(lucid, scriptParams, 100000000n, undefined, emulator)
let txHash23 = await (await tx23.sign().complete()).submit()

lucid.selectWalletFromPrivateKey(privateKey4);
let tx24 = await createStake(lucid, scriptParams, 100000000n, undefined, emulator)
let txHash24 = await (await tx24.sign().complete()).submit()
emulator.awaitBlock(1)

console.log("Stake (address1, address2, address3, and address4) created")
let tx2Utxo = await lucid.utxosByOutRef([{txHash: txHash2, outputIndex: 0}])
let tx22Utxo = await lucid.utxosByOutRef([{txHash: txHash22, outputIndex: 0}])
let tx23Utxo = await lucid.utxosByOutRef([{txHash: txHash23, outputIndex: 0}])
let tx24Utxo = await lucid.utxosByOutRef([{txHash: txHash24, outputIndex: 0}])
emulator.awaitBlock(1)
lucid.selectWalletFromPrivateKey(privateKey0);

// Update Stake
let tx3Utxo = await lucid.utxosByOutRef([{txHash: txHash1, outputIndex: 0}])
let tx3 = await updateStake(lucid, scriptParams, 100000000n, tx3Utxo[0], undefined)
let txHash3 = await (await tx3.sign().complete()).submit()
emulator.awaitBlock(1)
console.log("Stake (address0) updated")
let tx4Utxo = await lucid.utxosByOutRef([{txHash: txHash3, outputIndex: 0}])

let effectMap: any = new Map();
// effectMap.set("0", new Map());
effectMap.set(0n, new Map()) // = new Map();
console.log("effectMap", effectMap)
// Create Effects
let {hashedEffects, votes} = await prepareEffects(lucid, effectMap, undefined)
console.log("hashedEffects", hashedEffects)
console.log("votes", votes)

let effectScripts: Map<number, Map<Script, [arg0: Datum, arg1: Script | undefined]>> = new Map();
effectScripts.set(0, new Map());

// Create Proposal
console.log('scriptParams', scriptParams)
console.log('tx3Utxo', tx3Utxo)
console.log('utxo0', utxo0)
console.log('hashedEffects', hashedEffects)
console.log('votes', votes)
let tx4 = {tx: await lucid.newTx().complete()}
try {
    tx4 = await createProposal(lucid, scriptParams, tx4Utxo[0], tx4Utxo[0].datum || "", utxo0[0], utxo0[0].datum || "", {effects: hashedEffects, votes: votes}, stakeValidatorRef[0], proposalPolicyRef[0], govValidatorRef[9], emulator)
} catch (e) {
    console.log('address0', address0)
    throw e
}
let txHash4 = await (await tx4.tx.sign().complete()).submit()
emulator.awaitBlock(11)
console.log("Proposal created")
let tx5Utxo = await lucid.utxosByOutRef([{txHash: txHash4, outputIndex: 1}])
console.log("correct StakeLock", tx5Utxo[0].datum)
let tx5pUtxo = await lucid.utxosByOutRef([{txHash: txHash4, outputIndex: 0}])
let tx5gUtxo = await lucid.utxosByOutRef([{txHash: txHash4, outputIndex: 2}])

// Cosign Proposal 
lucid.selectWalletFromPrivateKey(privateKey1);
let tx5 = await cosignProp(lucid, scriptParams, tx2Utxo[0].datum || "", tx5pUtxo[0].datum || "", tx2Utxo[0], tx5pUtxo[0], stakeValidatorRef[0], proposalValidatorRef[0], emulator)
let txHash5 = await (await tx5.tx.sign().complete()).submit()
emulator.awaitBlock(1)
console.log("Proposal cosigned")
let tx6pUtxo = await lucid.utxosByOutRef([{txHash: txHash5, outputIndex: 0}])
let tx6Utxo = await lucid.utxosByOutRef([{txHash: txHash5, outputIndex: 1}])

// Advance Proposal
lucid.selectWalletFromPrivateKey(privateKey0);
let witnesses = [tx6Utxo[0], tx5Utxo[0]]
console.log('witnesses', witnesses)
let tx6 = await advanceProposal(lucid, scriptParams, tx6pUtxo[0], tx6pUtxo[0].datum || "", tx5gUtxo[0], tx5gUtxo[0].datum || "", effectMap, witnesses, proposalValidatorRef, govValidatorRef, emulator)
let txHash6 = await (await tx6.tx.sign().complete()).submit()
// let tx8gUtxo = await lucid.utxosByOutRef([{txHash: txHash6, outputIndex: 1}])
emulator.awaitBlock(35)
console.log("Proposal advanced after cosigning")

let tx7pUtxo = await lucid.utxosByOutRef([{txHash: txHash6, outputIndex: 0}])

// Vote on Proposal
lucid.selectWalletFromPrivateKey(privateKey2);
let tx7 = await permitVote(lucid, scriptParams, tx22Utxo, tx7pUtxo[0], 0n, stakeValidatorRef[0], proposalValidatorRef[0], emulator)
let txHash7 = await (await tx7.tx.sign().complete()).submit()
emulator.awaitBlock(30)
console.log("Proposal voted on")
let tx8pUtxo = await lucid.utxosByOutRef([{txHash: txHash7, outputIndex: 0}])
let tx72Utxo = await lucid.utxosByOutRef([{txHash: txHash7, outputIndex: 1}])

// Advance Proposal
lucid.selectWalletFromPrivateKey(privateKey0);
let tx8 = await advanceProposal(lucid, scriptParams, tx8pUtxo[0], tx8pUtxo[0].datum || "", tx5gUtxo[0], tx5gUtxo[0].datum || "", effectMap, undefined, proposalValidatorRef, govValidatorRef, emulator)
let txHash8 = await (await tx8.tx.sign().complete()).submit()
emulator.awaitBlock(35)
console.log("Proposal advanced after vote")

let tx9pUtxo = await lucid.utxosByOutRef([{txHash: txHash8, outputIndex: 0}])

// Execute Proposal
let tx9 = await advanceProposal(lucid, scriptParams, tx9pUtxo[0], tx9pUtxo[0].datum || "", tx5gUtxo[0], tx5gUtxo[0].datum || "", effectMap, undefined, proposalValidatorRef, govValidatorRef, emulator)
let txHash9 = await (await tx9.tx.sign().complete()).submit()
emulator.awaitBlock(1)
console.log("GATs minted. (0)")
let tx9gUtxo = await lucid.utxosByOutRef([{txHash: txHash9, outputIndex: 1}])

// Here we need to actually spend the GATs from their addresses based on the effectScripts.
console.log("Proposal executed (0)")

// Get Script(s)
let noOpScript: Script = await noOp(scriptParams)
let governorMutation: Script = await mutateGovernor(scriptParams)
let treasurySpend: Script = await spendFromTreasury(scriptParams)
// let 
console.log("...")

let treasuryScript: Script = await getTreasuryValidator(scriptParams)

// Get Datum(s)
console.log("Getting Datums")
const { propThresholds, nextPropId, timingConfig, maxTimeRange, maxProposalsPerStake} = deserializeGov(initialGovernorDatum)
let mutateGovDatum = GOVERNOR_UPDATE_DATUM(propThresholds, nextPropId, timingConfig, maxProposalsPerStake, maxTimeRange, effectDat.newThresholds, effectDat.newPropTimings, effectDat.newProposalValidLength, effectDat.newProposalsPerStake)
console.log("After mutate gov created.")
let a: Assets = {['lovelace']: 10000000n}
let r: [arg0: string, arg1: Assets, arg2: undefined][]= [[await lucid.wallet.address(), a, undefined]]
let spendDatum = { receivers: r, treasuries: [lucid.utils.validatorToAddress(treasuryScript)]}
let adDets = await lucid.utils.getAddressDetails(await lucid.wallet.address())
if (!adDets.paymentCredential) {
    throw new Error("No payment credential")
}
console.log("adDets", adDets)
let treasuryDatum = MAKE_TREASURY_WITHDRAWAL([[adDets.paymentCredential, {['lovelace']: 10000000n}]], [lucid.utils.scriptHashToCredential(lucid.utils.validatorToScriptHash(treasuryScript))])

let effectMap2: any = new Map();
let operations = new Map();
operations.set(lucid.utils.validatorToScriptHash(governorMutation), [lucid.utils.datumToHash(mutateGovDatum), undefined]);
operations.set(lucid.utils.validatorToScriptHash(treasurySpend), [lucid.utils.datumToHash(toHex(treasuryDatum.to_bytes())), undefined]);
effectMap2.set(0n, new Map())
let effect1 = new Map();
effect1.set(treasurySpend, [toHex(treasuryDatum.to_bytes()), undefined]);
effect1.set(governorMutation, [mutateGovDatum, undefined]);
effectMap2.set(1n, effect1)

let effectsAndVotes = await prepareEffects(lucid, effectMap2, undefined)

// Create Proposal
console.log('scriptParams', scriptParams)
console.log('tx3Utxo', tx3Utxo)
console.log('utxo0', utxo0)
console.log('hashedEffects', effectsAndVotes.hashedEffects)
console.log('votes', effectsAndVotes.votes)
let tx10 = {tx: await lucid.newTx().complete()}
try {
    tx10 = await createProposal(lucid, scriptParams, tx5Utxo[0], tx5Utxo[0].datum || "", tx9gUtxo[0], tx9gUtxo[0].datum || "", {effects: effectsAndVotes.hashedEffects, votes: effectsAndVotes.votes}, stakeValidatorRef[0], proposalPolicyRef[0], govValidatorRef[9], emulator)
} catch (e) {
    console.log('address0', address0)
    throw e
}
let tx10Signed = (await tx10.tx.sign().complete())
let txHash10 = await tx10Signed.submit()
emulator.awaitBlock(11)
console.log("Proposal created (1)")
let tx11Utxo = await lucid.utxosByOutRef([{txHash: txHash10, outputIndex: 1}])
console.log("correct StakeLock", tx11Utxo[0].datum)
let tx11pUtxo = await lucid.utxosByOutRef([{txHash: txHash10, outputIndex: 0}])
console.log('proposal1 datum', tx11pUtxo[0].datum)
let tx11gUtxo = await lucid.utxosByOutRef([{txHash: txHash10, outputIndex: 2}])

// Cosign Proposal 
lucid.selectWalletFromPrivateKey(privateKey1);
let tx11 = await cosignProp(lucid, scriptParams, tx6Utxo[0].datum || "", tx11pUtxo[0].datum || "", tx6Utxo[0], tx11pUtxo[0], stakeValidatorRef[0], proposalValidatorRef[0], emulator)
let txHash11 = await (await tx11.tx.sign().complete()).submit()
emulator.awaitBlock(1)
console.log("Proposal cosigned (1)")
let tx12pUtxo = await lucid.utxosByOutRef([{txHash: txHash11, outputIndex: 0}])
let tx12Utxo = await lucid.utxosByOutRef([{txHash: txHash11, outputIndex: 1}])

// Advance Proposal
lucid.selectWalletFromPrivateKey(privateKey0);
let witnesses2 = [tx12Utxo[0], tx11Utxo[0]]
console.log('witnesses', witnesses)
let tx12 = await advanceProposal(lucid, scriptParams, tx12pUtxo[0], tx12pUtxo[0].datum || "", tx11gUtxo[0], tx11gUtxo[0].datum || "", effectMap2, witnesses2, proposalValidatorRef, govValidatorRef, emulator)
let txHash12 = await (await tx12.tx.sign().complete()).submit()
// let tx8gUtxo = await lucid.utxosByOutRef([{txHash: txHash6, outputIndex: 1}])
emulator.awaitBlock(35)
console.log("Proposal advanced after cosigning (1)")

let tx13pUtxo = await lucid.utxosByOutRef([{txHash: txHash12, outputIndex: 0}])

// Vote on Proposal
lucid.selectWalletFromPrivateKey(privateKey2);
let tx13 = await permitVote(lucid, scriptParams, tx72Utxo, tx13pUtxo[0], 1n, stakeValidatorRef[0], proposalValidatorRef[0], emulator)
let txHash13 = await (await tx13.tx.sign().complete()).submit()
emulator.awaitBlock(30)
console.log("Proposal voted on (1)")
let tx14pUtxo = await lucid.utxosByOutRef([{txHash: txHash13, outputIndex: 0}])
let tx14sUtxo = await lucid.utxosByOutRef([{txHash: txHash13, outputIndex: 1}])

// Advance Proposal
lucid.selectWalletFromPrivateKey(privateKey0);
let tx14 = await advanceProposal(lucid, scriptParams, tx14pUtxo[0], tx14pUtxo[0].datum || "", tx11gUtxo[0], tx11gUtxo[0].datum || "", effectMap2, undefined, proposalValidatorRef, govValidatorRef, emulator)
let txHash14 = await (await tx14.tx.sign().complete()).submit()
emulator.awaitBlock(35)
console.log("Proposal advanced after vote (1)")

let tx15pUtxo = await lucid.utxosByOutRef([{txHash: txHash14, outputIndex: 0}])

// Execute Proposal
console.log('proposal1 before execute', tx15pUtxo[0].datum)
let tx15 = await advanceProposal(lucid, scriptParams, tx15pUtxo[0], tx15pUtxo[0].datum || "", tx11gUtxo[0], tx11gUtxo[0].datum || "", effectMap2, undefined, proposalValidatorRef, govValidatorRef, emulator)
console.log('post balance execute witness', toHex(tx15.tx.witnessSetBuilder.build().to_bytes()))
console.log('post balance execute tx', toHex(tx15.tx.txComplete.to_bytes()))
let tx15Signed = (await tx15.tx.sign().complete())
console.log('post balance execute witness', toHex(tx15Signed.txSigned.witness_set().to_bytes()))
let txHash15 = await tx15Signed.submit()
emulator.awaitBlock(1)
console.log("GATs minted. (1)")
console.log("txHash15", txHash15)
let spendUtxo = await lucid.utxosByOutRef([{txHash: txHash15, outputIndex: 2}])

// Pay the treasury 100 ADA
let payTres = await (await (await lucid.newTx()
                        .payToContract(lucid.utils.validatorToAddress(treasuryScript), Data.void(), {['lovelace']: 100000000n})
                        .complete()).sign().complete()).submit()
console.log("payTres", payTres)
emulator.awaitBlock(1)
let tUtxo = await lucid.utxosByOutRef([{txHash: payTres, outputIndex: 0}])

console.log("treasuryDatum", toHex(treasuryDatum.to_bytes()))
let tx16 = await spendFromTreasuryTx(lucid, scriptParams, spendUtxo[0], spendDatum, undefined, undefined)
if (!tx16) {
    throw "tx16 undefined"
}
console.log("treasuryCred", lucid.utils.getAddressDetails(lucid.utils.validatorToAddress(treasuryScript)).paymentCredential?.hash)
console.log("effectCredential", lucid.utils.getAddressDetails(lucid.utils.validatorToAddress(treasurySpend)).paymentCredential?.hash)
console.log("tx16", tx16 ? toHex(tx16.tx.txComplete.to_bytes()) : "undefined")
lucid.selectWalletFromPrivateKey(privateKey0);
let txHash16 = await (await tx16.tx.sign().complete()).submit()
console.log("txHash16", txHash16)
emulator.awaitBlock(1)

let noOpUtxos = await lucid.utxosAt(lucid.utils.validatorToAddress(await noOp(scriptParams)))
let treasurySpendUtxos = await lucid.utxosAt(lucid.utils.validatorToAddress(treasurySpend))
console.log(noOpUtxos)
console.log(treasurySpendUtxos)


// Mutate Governor
let mutateUtxo = await lucid.utxosByOutRef([{txHash: txHash15, outputIndex: 3}])
let govUtxo = await lucid.utxosByOutRef([{txHash: txHash15, outputIndex: 1}])
let tx17 = await mutateGovernorTx(lucid, scriptParams, mutateUtxo[0], effectDat, govUtxo[0], govValidatorRef[0])
if (!tx17) {
    throw "tx17 undefined"
}
let txHash17 = await (await tx17.tx.sign().complete()).submit()
emulator.awaitBlock(1)

// Here we need to actually spend the GATs from their addresses based on the effectScripts.
console.log("Proposal executed (1)")
let tx18pUtxo = await lucid.utxosByOutRef([{txHash: txHash15, outputIndex: 0}])

lucid.selectWalletFromPrivateKey(privateKey2);
let tx18 = await unlockVote(lucid, scriptParams, tx14sUtxo, tx18pUtxo[0], undefined, undefined, emulator)
if (!tx18) {
    throw "tx18 undefined"
}
let txHash18 = await (await tx18.tx.sign().complete()).submit()
emulator.awaitBlock(1)
console.log("All Success")

let newScript: ScriptParams = {
    gstOutRef: {
      txOutRefId: '07215208bb31c7c66e5213a8c9a81c18421b3371a424d2e61aea35bfd9038e3f',
      txOutRefIdx: 3
    },
    gtClassRef: [
      'f6f49b186751e61f1fb8c64e7504e771f968cea9f4d11f5222b169e3',
      '74484f534b59'
    ],
    maximumCosigners: 100
  }

const printAllScripts = async (scriptParams: ScriptParams) => {

    const authPolicy = await getAuthorityPolicy(scriptParams)
    const authPolicyHash = await lucid.utils.validatorToScriptHash(authPolicy)

    const stakePolicy = await getStakePolicy(scriptParams)
    const stakePolicyHash = await lucid.utils.validatorToScriptHash(stakePolicy)

    const stakeValidator = await getStakeValidator(scriptParams)
    const stakeValidatorHash = await lucid.utils.validatorToScriptHash(stakeValidator)

    const proposalPolicy = await getProposalPolicy(scriptParams)
    const proposalPolicyHash = await lucid.utils.validatorToScriptHash(proposalPolicy)

    const proposalValidator = await getProposalValidator(scriptParams)
    const proposalValidatorHash = await lucid.utils.validatorToScriptHash(proposalValidator)

    const governorPolicy = await getGovernorPolicy(scriptParams)
    const governorPolicyHash = await lucid.utils.validatorToScriptHash(governorPolicy)

    const governorValidator = await getGovernorValidator(scriptParams)
    const governorValidatorHash = await lucid.utils.validatorToScriptHash(governorValidator)

    const printVal = {
        authPolicy: authPolicy.script,
        authPolicyHash: authPolicyHash,
        stakePolicy: stakePolicy.script,
        stakePolicyHash: stakePolicyHash,
        stakeValidator: stakeValidator.script,
        stakeValidatorHash: stakeValidatorHash,
        proposalPolicy: proposalPolicy.script,
        proposalPolicyHash: proposalPolicyHash,
        proposalValidator: proposalValidator.script,
        proposalValidatorHash: proposalValidatorHash,
        governorPolicy: governorPolicy.script,
        governorPolicyHash: governorPolicyHash,
        governorValidator: governorValidator.script,
        governorValidatorHash: governorValidatorHash
    }
    
    fs.writeFile('output.json', JSON.stringify(printVal, null, 2), (err) => {
        if (err) throw err;
        console.log('Data written to file');
    });
    // console.log(printVal)
}

// console.log('testscripts:')
// await printAllScripts(scriptParams)

// console.log('newScript:--------')
// await printAllScripts(newScript)