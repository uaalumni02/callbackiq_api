import { observeCustomerConstraint, respectCustomerConstraints, currentConstraints } from '../../src/services/conversationCondition.service.js';
import { getEmergencyReply } from '../../src/helpers/ai/aiGuardrails.js';
import { classifyOperationalUrgency } from '../../src/services/scheduling/customerSchedulingIntent.service.js';
import { ensureUrgentOperationalResult, ensureHumanHandoffResult } from '../../src/services/messaging/smsHandoff.service.js';
const context = () => ({ conversation: { status: 'open', conversationMemory: { recoveryIntake: { journeyKey: '', date: '2026-09-10', time: '8:00' } }, save: jest.fn().mockResolvedValue(null) }, lead: { serviceNeeded: 'Dishwasher leaking', urgency: 'medium', address: '970 Sidney Marcus Blvd NE, 30324', preferredAppointmentTime: '2026-09-10' } });
test.each(['sms', 'voice'])('%s persists inability before acknowledging it, preserves date and address', async channel => {
 const ctx = context();
 const result = await observeCustomerConstraint({ ...ctx, channel, customerMessage: "I can't turn the water off" });
 expect(ctx.conversation.save).toHaveBeenCalledTimes(1);
 expect(result.reply).toMatch(/unable to shut off/); expect(result.reply).toMatch(/leaking right now/);
 expect(result.reply).not.toMatch(/if.*turn it off|what time/i);
 expect(ctx.conversation.conversationMemory.recoveryIntake.date).toBe('2026-09-10');
 expect(result.address).toContain('970'); expect(result.shouldAlertOwner).toBe(true);
 expect(currentConstraints(ctx.conversation)).toEqual(['water_control_unavailable']);
});
test('persistence failure is not acknowledged', async () => {
 const ctx=context(); ctx.conversation.save.mockRejectedValue(new Error('write failed'));
 await expect(observeCustomerConstraint({...ctx,customerMessage:"I cannot reach the water shutoff"})).rejects.toThrow('write failed');
});
test.each(["I can't turn the water off", 'I cannot reach the water valve', "I can’t find the water shutoff"] )('removes unavailable water instruction while retaining danger guidance: %s', async customerMessage => {
 const ctx=context(); await observeCustomerConstraint({...ctx,customerMessage});
 const reply=respectCustomerConstraints(getEmergencyReply('flood'),{conversation:ctx.conversation});
 expect(reply).not.toMatch(/shut off|turn.*off/i); expect(reply).toMatch(/standing water|outlets/); expect(reply).toMatch(/911/);
});
test('power limitation applies to later replies across channel changes', async () => {
 const ctx=context(); await observeCustomerConstraint({...ctx,customerMessage:'I cannot reach the breaker'});
 const reply=respectCustomerConstraints(getEmergencyReply('electrical'),ctx);
 expect(reply).not.toMatch(/shut off power/i); expect(reply).toMatch(/911/); expect(reply).toMatch(/Stay away/);
});
test('a new journey does not inherit limitations', async () => {
 const ctx=context(); await observeCustomerConstraint({...ctx,customerMessage:'I cannot reach the breaker'});
 ctx.conversation.orchestration={recoveryJourneyKey:'new'};
 expect(currentConstraints(ctx.conversation)).toEqual([]);
});
test('affirmed danger still reaches emergency handling', async () => {
 const ctx=context();
 expect(await observeCustomerConstraint({...ctx,customerMessage:"I can't turn the water off and my house is flooding"})).toBeNull();
 expect(currentConstraints(ctx.conversation)).toContain('water_control_unavailable');
});
test.each(['plumbing','hvac','electrical','roofing','restoration','garage_door','locksmith','landscaping'])('%s urgency wrapper does not replace or prepend the selected action', businessType => {
 const result={ urgency:'high', messageCategory:'service_request', reply:'What is the ZIP code for that address?' };
 const out=ensureUrgentOperationalResult({result,business:{businessType},lead:{serviceNeeded:'leak'}});
 expect(out.reply).toBe(result.reply); expect(out.shouldAlertOwner).toBe(true);
});
test('dishwasher mention alone does not establish active leakage', () => {
 expect(classifyOperationalUrgency('My dishwasher is leaking')).toBe('');
 expect(classifyOperationalUrgency('My dishwasher is actively leaking')).toBe('high');
});
test('handoff preserves the hazard-specific response instead of generic plumbing instructions', () => {
 const reply=getEmergencyReply('gas');
 const out=ensureHumanHandoffResult({business:{businessType:'plumbing'},result:{messageCategory:'emergency',riskFlags:['safety_hazard'],reply},customerMessage:'I smell gas'});
 expect(out.reply).toContain('gas'); expect(out.reply).toContain('911'); expect(out.reply).not.toMatch(/shutoff|fixture/);
});


test.each(['water', 'power'])('a contextual yes escalates confirmed %s concern and never resumes scheduling', async kind => {
 const ctx=context();
 await observeCustomerConstraint({...ctx,customerMessage:`I cannot turn the ${kind} off`});
 const result=await observeCustomerConstraint({...ctx,customerMessage:'Yes'});
 expect(result.riskFlags).toContain('safety_hazard'); expect(result.intakeReady).toBe(false);
 expect(result.reply).toMatch(/911/); expect(result.reply).not.toMatch(/shut off|what time/i);
 expect(ctx.conversation.conversationMemory.recoveryIntake.date).toBe('2026-09-10');
});
test('hypothetical limitations are not recorded as customer facts', async () => {
 const ctx=context(); expect(await observeCustomerConstraint({...ctx,customerMessage:"What if I can't turn the water off?"})).toBeNull();
 expect(ctx.conversation.save).not.toHaveBeenCalled();
});

test('an unspecified limitation is clarified before choosing water or power instructions', async () => {
 const ctx=context();
 const question=await observeCustomerConstraint({...ctx,customerMessage:"I can't shut it off"});
 expect(question.reply).toMatch(/What are you unable/);
 const clarified=await observeCustomerConstraint({...ctx,customerMessage:'The water'});
 expect(clarified.reply).toMatch(/water still leaking/);
 expect(currentConstraints(ctx.conversation)).toContain('water_control_unavailable');
});
test('a negative condition answer cannot remain pending and turn a later yes into a hazard', async () => {
 const ctx=context(); await observeCustomerConstraint({...ctx,customerMessage:'I cannot reach the breaker'});
 expect(await observeCustomerConstraint({...ctx,customerMessage:'No'})).toBeNull();
 expect(await observeCustomerConstraint({...ctx,customerMessage:'Yes'})).toBeNull();
});
test('intentional silence remains silence', () => {
 expect(respectCustomerConstraints('',context())).toBe('');
});


test('mixed water and electrical context preserves the actual unavailable control', async () => {
 const ctx=context(); await observeCustomerConstraint({...ctx,customerMessage:"I cannot reach the breaker because water is on the floor"});
 expect(currentConstraints(ctx.conversation)).toContain('power_control_unavailable');
 expect(currentConstraints(ctx.conversation)).not.toContain('water_control_unavailable');
});
test('a gas valve is not assumed to be a water control', async () => {
 const ctx=context(); const result=await observeCustomerConstraint({...ctx,customerMessage:"I can't turn the gas valve"});
 expect(result?.reply || '').not.toMatch(/water still leaking/);
 expect(currentConstraints(ctx.conversation)).not.toContain('water_control_unavailable');
});
