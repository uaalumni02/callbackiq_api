// Synthetic provider boundary for the process-death contract. Never uses Twilio.
import mongoose from 'mongoose';
import {releaseTrackingNumberWithReceipt} from '../../src/services/trackingNumberProvisioning.service.js';
await mongoose.connect(process.env.SYNTHETIC_RELEASE_MONGO_URI,{autoIndex:false,maxPoolSize:2});
const client={incomingPhoneNumbers:()=>({remove:async()=>{
 process.send?.({event:'provider_accepted_without_receipt'});
 await new Promise(()=>{});
}})};
try {await releaseTrackingNumberWithReceipt(process.env.SYNTHETIC_RELEASE_BUSINESS_ID,{client});}
finally {await mongoose.disconnect();}
