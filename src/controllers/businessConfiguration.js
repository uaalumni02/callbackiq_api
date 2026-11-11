import BusinessConfigurationCatalogController from './businessConfiguration/Catalog.js';
import BusinessConfigurationAvailabilityController from './businessConfiguration/Availability.js';
import BusinessConfigurationPolicyController from './businessConfiguration/Policy.js';

class BusinessConfigurationController {
  static bootstrap(...args) { return BusinessConfigurationCatalogController.bootstrap(...args); }
  static listServices(...args) { return BusinessConfigurationCatalogController.listServices(...args); }
  static createService(...args) { return BusinessConfigurationCatalogController.createService(...args); }
  static updateService(...args) { return BusinessConfigurationCatalogController.updateService(...args); }
  static deleteService(...args) { return BusinessConfigurationCatalogController.deleteService(...args); }
  static getAvailability(...args) { return BusinessConfigurationAvailabilityController.getAvailability(...args); }
  static replaceAvailabilityRules(...args) { return BusinessConfigurationAvailabilityController.replaceAvailabilityRules(...args); }
  static createAvailabilityException(...args) { return BusinessConfigurationAvailabilityController.createAvailabilityException(...args); }
  static updateAvailabilityException(...args) { return BusinessConfigurationAvailabilityController.updateAvailabilityException(...args); }
  static deleteAvailabilityException(...args) { return BusinessConfigurationAvailabilityController.deleteAvailabilityException(...args); }
  static getSchedulingPolicy(...args) { return BusinessConfigurationPolicyController.getSchedulingPolicy(...args); }
  static saveSchedulingPolicy(...args) { return BusinessConfigurationPolicyController.saveSchedulingPolicy(...args); }
  static getServiceArea(...args) { return BusinessConfigurationPolicyController.getServiceArea(...args); }
  static saveServiceArea(...args) { return BusinessConfigurationPolicyController.saveServiceArea(...args); }
  static getOperationsSettings(...args) { return BusinessConfigurationPolicyController.getOperationsSettings(...args); }
  static saveOperationsSettings(...args) { return BusinessConfigurationPolicyController.saveOperationsSettings(...args); }
  static readiness(...args) { return BusinessConfigurationPolicyController.readiness(...args); }
  static evaluate(...args) { return BusinessConfigurationPolicyController.evaluate(...args); }
}

export default BusinessConfigurationController;
