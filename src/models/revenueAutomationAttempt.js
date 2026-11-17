import '../helpers/model/tenantContext.js';
import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
  business:{type:Schema.Types.ObjectId,ref:'Business',required:true},
  campaign:{type:Schema.Types.ObjectId,ref:'RevenueAutomationCampaign',required:true},
  sequence:{type:Number,min:1,max:3,required:true},
  operationKey:{type:String,required:true,maxlength:180},
  status:{type:String,enum:['reserved','suppressed','provider_accepted','delivered','delivery_failed','uncertain','failed'],default:'reserved'},
  providerMessageId:{type:String,maxlength:100,default:''},
  failureReason:{type:String,maxlength:240,default:''},
  sentAt:{type:Date,default:null},
  reconciledAt:{type:Date,default:null},
},{timestamps:true});
schema.index({business:1,operationKey:1},{unique:true});
schema.index({business:1,campaign:1,sequence:1},{unique:true});
schema.index({providerMessageId:1},{sparse:true});
export default mongoose.models.RevenueAutomationAttempt || mongoose.model('RevenueAutomationAttempt',schema);
