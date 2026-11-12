import test from 'node:test';
import {behavioralGuarantee,confirmationContracts} from './support/behavioralGuarantee.mjs';
test('commit-boundary logging and isolated reminder intervention are retained',()=>behavioralGuarantee(confirmationContracts,/reminder.*failure|socket and projection exceptions|provider acceptance does not notify|crash after Mongo confirmation/));
