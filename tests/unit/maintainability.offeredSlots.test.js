import { spreadSlotOptions, selectSlotOptions, selectOfferedSlot } from "../../src/services/booking/offeredSlotSelection.service.js";
import { selectOfferedSlot as legacyPublicExport } from "../../src/services/booking/bookingStateMachine.service.js";
const slots = Array.from({length:7},(_,i)=>({startAt:new Date(Date.UTC(2026,10,2+i,15)).toISOString(),label:"Option "+(i+1)}));
describe("booking selection refactor regression",()=>{
  test("legacy public export remains identical",()=>expect(legacyPublicExport).toBe(selectOfferedSlot));
  test("medium vs urgent ordering is unchanged",()=>{
    expect(spreadSlotOptions(slots,3)).toEqual([slots[0],slots[3],slots[6]]);
    expect(selectSlotOptions(slots,"medium",3)).toEqual([slots[0],slots[3],slots[6]]);
    expect(selectSlotOptions(slots,"emergency",3)).toEqual(slots.slice(0,3));
  });
  test("duplicates do not create phantom options",()=>{
    expect(selectSlotOptions([slots[0],{...slots[0],label:"other"},slots[1]],"high",3)).toEqual([slots[0],slots[1]]);
  });
  test("only unambiguous approvals select an offer",()=>{
    const offered=slots.slice(0,3);
    expect(selectOfferedSlot("2",offered,"America/New_York")).toBe(offered[1]);
    expect(selectOfferedSlot("option three please",offered,"America/New_York")).toBe(offered[2]);
    expect(selectOfferedSlot("no, option 2",offered,"America/New_York")).toBeNull();
  });
});
