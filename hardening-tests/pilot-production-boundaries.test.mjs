import test from 'node:test';
import {behavioralGuarantee,persistenceContracts} from './support/behavioralGuarantee.mjs';
test("Twilio production webhook signature checks fail closed",()=>behavioralGuarantee(['tests/unit/validateTwilioSignature.releaseRatchet.test.js'],new RegExp("falls back to req.protocol")));
test("owner appointment routes retain authentication and subscription gates",()=>behavioralGuarantee(persistenceContracts,new RegExp("appointment approval requires authentication")));
test("business-scoped ownership is checked on appointment operations",()=>behavioralGuarantee(persistenceContracts,new RegExp("appointment approval requires authentication")));
test("SMS webhook processing uses persisted idempotent work",()=>behavioralGuarantee(['tests/integration/sms10of10.adversarial.mongo.test.js'],new RegExp("primary and fallback delivery|crash after Message persistence")));
test("the maintenance role is not conflated with SMS-only workers",()=>behavioralGuarantee(['tests/unit/workerProcessRoles.production.test.js'],new RegExp("maintenance and SMS process roles")));
test("unsupported scheduling providers continue to fail closed",()=>behavioralGuarantee(['tests/unit/unsupportedSchedulingProviders.test.js'],new RegExp("rejects .* until configured")));
