// This test imports no app/server bootstrap: the worker dependency owns its refs.
import mongoose from 'mongoose';
import AlertService from '../../src/services/alert.service.js';
test('standalone alert service registers models required for population',()=>{
 expect(typeof AlertService.createSystemAlert).toBe('function');
 expect(mongoose.models.Lead).toBeDefined();expect(mongoose.models.Business).toBeDefined();
});
