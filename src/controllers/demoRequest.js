import DemoRequestPublicController from './demoRequest/Public.js';
import DemoRequestBookingController from './demoRequest/Booking.js';
import DemoRequestAdministrationController from './demoRequest/Administration.js';

class DemoRequestController {
  static createDemoRequest(...args) { return DemoRequestPublicController.createDemoRequest(...args); }
  static bookDemoRequest(...args) { return DemoRequestPublicController.bookDemoRequest(...args); }
  static getAvailability(...args) { return DemoRequestPublicController.getAvailability(...args); }
  static getPublicDemoRequest(...args) { return DemoRequestPublicController.getPublicDemoRequest(...args); }
  static scheduleDemoRequest(...args) { return DemoRequestBookingController.scheduleDemoRequest(...args); }
  static rescheduleDemoRequest(...args) { return DemoRequestBookingController.rescheduleDemoRequest(...args); }
  static cancelDemoRequest(...args) { return DemoRequestBookingController.cancelDemoRequest(...args); }
  static getCalendarFile(...args) { return DemoRequestBookingController.getCalendarFile(...args); }
  static getDemoRequests(...args) { return DemoRequestAdministrationController.getDemoRequests(...args); }
  static getDemoRequestById(...args) { return DemoRequestAdministrationController.getDemoRequestById(...args); }
  static updateDemoRequest(...args) { return DemoRequestAdministrationController.updateDemoRequest(...args); }
  static deleteDemoRequest(...args) { return DemoRequestAdministrationController.deleteDemoRequest(...args); }
}

export default DemoRequestController;
