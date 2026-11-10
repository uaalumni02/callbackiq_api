/* Source-exact AppointmentService extraction. Preserve order and outcome contracts. */
export function createAppointmentrecheckAndConfirm1Methods(deps) {
  const { assertConfirmationNotPending, assertIntakeHoldCurrent, Appointment, addMinutes, assertDistributedLeaseActive, exactSlotAvailable, getAppointmentForBusiness, getSlotCapacity, getSlotClaimKeys, getSlotKey, repairConfirmedApproval, tryRepairAppointmentProjections, withDistributedLease } = deps;
  return {
async recheckAndConfirm({ business, appointmentId, approvedBy }) {
    if (!approvedBy) throw Object.assign(new Error('Staff approval is required.'), { statusCode: 403 });
    const lease = await withDistributedLease(`appointment-approval:${appointmentId}`, async () => {
      let appointment = await getAppointmentForBusiness(business._id, appointmentId);
      assertConfirmationNotPending(appointment);
      if (appointment.status === 'confirmed') {
        await repairConfirmedApproval({ appointment, business });
        await tryRepairAppointmentProjections(appointment);
        return appointment;
      }
      if (!(appointment.status === 'held' || (appointment.requiresBusinessApproval === true && appointment.status === 'failed' && /hold expired/i.test(appointment.failureReason)))) {
        throw Object.assign(new Error('This appointment is not awaiting approval.'), { statusCode: 409 });
      }
      if (appointment.status === 'held' && appointment.heldExpiresAt > new Date()) return this.confirm({ business, appointmentId, approvedBy });
      await assertIntakeHoldCurrent(appointment);
      const available = await exactSlotAvailable({ business, serviceOfferingId: appointment.serviceOffering,
        startAt: appointment.startAt, endAt: appointment.endAt, postalCode: appointment.address?.postalCode, excludeAppointmentId: appointment._id, approvedExistingRequest: true });
      if (!available) throw Object.assign(new Error('That time is no longer available. Contact the customer to agree another time.'), { statusCode: 409, code: 'SLOT_UNAVAILABLE' });
      const capacity = await getSlotCapacity({ businessId: business._id, startAt: appointment.startAt, timeZone: appointment.timezone });
      let claimed = false;
      for (let lane = 1; lane <= capacity; lane++) {
        try {
          assertDistributedLeaseActive();
          appointment = await Appointment.findOneAndUpdate({ _id: appointment._id, business: business._id,
            status: appointment.status, 'confirmationIntent.status': { $ne: 'pending_provider' } }, { $set: { status: 'held', heldExpiresAt: addMinutes(new Date(), 5),
            failureReason: '', capacityLane: lane, activeSlotKey: `${getSlotKey(appointment.startAt, appointment.endAt)}|lane:${lane}`,
            slotClaimKeys: getSlotClaimKeys({ ...appointment.toObject(), capacityLane: lane }),
            'approvalRecovery.reconciled': false, 'approvalRecovery.state': 'pending',
          } }, { returnDocument: "after", runValidators: true });
          if (!appointment) throw Object.assign(new Error('The request changed. Reload it before approving.'), { statusCode: 409 });
          claimed = true; break;
        } catch (error) { if (error.code !== 11000) throw error; }
      }
      if (!claimed) throw Object.assign(new Error('Another customer claimed that time.'), { statusCode: 409 });
      return this.confirm({ business, appointmentId, approvedBy });
    });
    if (!lease.acquired) throw Object.assign(new Error('Another approval is being processed. Reload this request.'), { statusCode: 409 });
    return lease.value;
  }
  };
}
