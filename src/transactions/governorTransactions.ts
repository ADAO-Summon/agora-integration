import {Assets, C, Data, Datum, fromHex, DatumHash, Lucid, PaymentKeyHash, Script, ScriptHash, toHex, Tx, UTxO, Emulator, Credential} from 'lucid-cardano'
import {getAuthorityPolicy, getGovernorPolicy, getGovernorValidator, getProposalPolicy, getProposalValidator, getStakePolicy, getStakeValidator, ScriptParams} from '../../resources/plutus.js'
import {deserializeGov, deserializeProposal, deserializeStake, filterUtxosByRef, getLucid, getLucidWithCredential, gtAsset, subAssetsFromUtxos} from '../summon-utils/util/sc.js'

const createGovernor = async (
    lucid: Lucid,
    initialUtxo: UTxO[],
    scriptParams: ScriptParams,
    datum: Datum,
    emulator: Emulator | undefined = undefined
) => {
    try {
        let ad = await lucid.wallet.address();
        const govValidator = await getGovernorValidator(scriptParams)
        const proposalValidator = await getProposalValidator(scriptParams)
        const stakeValidator = await getStakeValidator(scriptParams)
        const govPolicy = await getGovernorPolicy(scriptParams)

        let readFromUtxo = false;
        
        const governorValidatorAddress = lucid.utils.validatorToAddress(govValidator)
        const govPolicyUtxos = await lucid.utxosAt(lucid.utils.validatorToAddress(govPolicy))
        const govPolRefUtxos = govPolicyUtxos.filter((v: any, i: any, a: any) => {
            return v.scriptRef && v.scriptRef == govPolicy
        })
        if (govPolRefUtxos.length != 0) {
            readFromUtxo = true
        }
        const stateThread = lucid.utils.validatorToScriptHash(govPolicy)
        const mintAssets : Assets = {}
        mintAssets[stateThread] = 1n;
        
        const spendToValidator : Assets = {}
        spendToValidator[stateThread] = 1n;
        spendToValidator['lovelace'] = 2000000n;
        const sc: Credential = {type: 'Key', hash: 'e1cdd647d7e931bfbe0a81468214dab248be894e898bb01ebe0b646d'}

        const nsAddress = lucid.utils.validatorToAddress(lucid.utils.nativeScriptFromJson({
            type: "sig",
            keyHash: lucid.utils.getAddressDetails(ad).paymentCredential!.hash
        }), sc)

        let tx;
        let txComplete;
        try {
            tx = lucid.newTx()
                .collectFrom(initialUtxo)
                .mintAssets(mintAssets, Data.void())
                .validTo(Date.now().valueOf() + 900000)
            if (readFromUtxo) {
                tx = tx.readFrom([govPolRefUtxos[0]])
            } else {
                tx = tx.attachMintingPolicy(govPolicy)
            }
            tx = tx.payToContract(governorValidatorAddress, {inline: datum}, spendToValidator)
            if (!emulator) {
                tx = tx.payToAddressWithData(nsAddress, {scriptRef: proposalValidator}, {lovelace: 1000000n})
                    .payToAddressWithData(nsAddress, {scriptRef: stakeValidator}, {lovelace: 1000000n})
            }

            txComplete = await tx.complete()
        } catch (e) { 
            console.log(e)
        }
        if (!txComplete) throw "The tx never got built."
        return txComplete
    } catch (e) {
        console.log(e)
        throw e
    }
}

export { createGovernor }