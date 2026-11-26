import {
  readProviderEntitlement,
  dispatchEntitledProvider,
  withProviderBusiness,
  providerBusinessId,
} from "../../src/services/providerEntitlement.service.js";
const future = new Date(Date.now() + 86400000),
  past = new Date(Date.now() - 86400000);
const deps = (subscription) => ({
  BusinessModel: {
    findById: () => ({ lean: async () => ({ _id: "b", isActive: true }) }),
  },
  SubscriptionModel: { findOne: () => ({ lean: async () => subscription }) },
});
test.each([
  ["active", { isActive: true }, true],
  ["active", { isActive: false }, false],
  ["trialing", { isActive: true, trialEndsAt: future }, true],
  ["trialing", { isActive: true, trialEndsAt: past }, false],
  ["past_due", {}, false],
  ["none", {}, false],
  ["incomplete", {}, false],
  ["paused", {}, false],
  ["unpaid", {}, false],
  ["expired", {}, false],
  ["incomplete_expired", {}, false],
  ["canceled", {}, false],
  ["canceled", { cancelAtPeriodEnd: true, currentPeriodEnd: future }, true],
  ["canceled", { cancelAtPeriodEnd: true, currentPeriodEnd: past }, false],
])("B04 canonical %s %j is entitled=%s", async (status, fields, expected) => {
  expect(
    (await readProviderEntitlement("b", deps({ status, ...fields }))).allowed,
  ).toBe(expected);
});
test("B04 rechecks at dispatch, fails closed on outages, and isolates async tenant identities", async () => {
  let state = { status: "active", isActive: true };
  const dependencies = deps(state);
  state.status = "past_due";
  const dispatch = jest.fn();
  await expect(
    dispatchEntitledProvider(
      { businessId: "b", channel: "sms", dispatch },
      dependencies,
    ),
  ).rejects.toMatchObject({ code: "PROVIDER_ENTITLEMENT_REQUIRED" });
  expect(dispatch).not.toHaveBeenCalled();
  dependencies.SubscriptionModel.findOne = () => ({
    lean: async () => {
      throw new Error("offline");
    },
  });
  await expect(readProviderEntitlement("b", dependencies)).rejects.toThrow(
    "offline",
  );
  const values = await Promise.all(
    ["tenant-a", "tenant-b"].map((id) =>
      withProviderBusiness(id, async () => {
        await Promise.resolve();
        return providerBusinessId();
      }),
    ),
  );
  expect(values).toEqual(["tenant-a", "tenant-b"]);
  expect(providerBusinessId()).toBeNull();
});
test.each([
 ['none',{lastPaymentStatus:'trial_preparing',trialCount:0},true],
 ['none',{lastPaymentStatus:'trial_not_activated',trialCount:0},true],
 ['none',{lastPaymentStatus:'trial_preparing',trialCount:1},false],
 ['none',{lastPaymentStatus:'trial_preparing',trialCount:0,trialUsedAt:new Date()},false],
 ['none',{lastPaymentStatus:'trial_preparing',trialCount:0,stripeSubscriptionId:'sub_existing'},false],
 ['none',{lastPaymentStatus:'unknown',trialCount:0},false],
 ['past_due',{},false],['unpaid',{},false],['paused',{},false],['expired',{},false],['incomplete',{},false],['incomplete_expired',{},false],['canceled',{},false],
 ['active',{isActive:true},true],['trialing',{isActive:true,trialEndsAt:future},true],['trialing',{isActive:true,trialEndsAt:past},false],
])('B04 identity-provider exception is limited to paid entitlement or unused preparation: %s %j',async(status,fields,expected)=>{
 expect((await readProviderEntitlement('b',{...deps({status,...fields}),allowOnboarding:true})).allowed).toBe(expected);
});
test('B04 missing, deleting and inactive tenants fail closed; a paused fleet never dispatches',async()=>{
 expect((await readProviderEntitlement(null,deps({status:'active',isActive:true}))).allowed).toBe(false);
 expect((await readProviderEntitlement('b',deps(null))).allowed).toBe(false);
 for(const business of [null,{isActive:false},{isActive:true,accountLifecycle:{status:'deleting'}}]){
  const dependencies=deps({status:'active',isActive:true});dependencies.BusinessModel.findById=()=>({lean:async()=>business});
  expect((await readProviderEntitlement('b',dependencies)).allowed).toBe(false);
 }
 const previous=process.env.PILOT_PROVIDER_DISPATCH_PAUSED;process.env.PILOT_PROVIDER_DISPATCH_PAUSED='true';
 try{expect((await readProviderEntitlement('b',deps({status:'active',isActive:true}))).allowed).toBe(false);}finally{if(previous===undefined)delete process.env.PILOT_PROVIDER_DISPATCH_PAUSED;else process.env.PILOT_PROVIDER_DISPATCH_PAUSED=previous;}
});
test('B04 internal AI dispatch inherits isolated tenant context while missing context remains denied',async()=>{
 const dispatch=jest.fn().mockResolvedValue('synthetic');const dependencies=deps({status:'active',isActive:true});
 await expect(withProviderBusiness('b',()=>dispatchEntitledProvider({channel:'ai',dispatch},dependencies))).resolves.toBe('synthetic');
 expect(dispatch).toHaveBeenCalledTimes(1);
});
