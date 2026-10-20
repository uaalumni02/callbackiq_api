import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
  business:{type:Schema.Types.ObjectId,ref:'Business',required:true,index:true},
  opportunity:{type:Schema.Types.ObjectId,ref:'RevenueRescueOpportunity',required:true},
  record:{type:Schema.Types.ObjectId,ref:'InternalRevenueRecord',default:null},
  phone:{type:String,required:true,maxlength:40},
  purpose:{type:String,enum:['estimate_followup','booking_followup','service_reactivation','invoice_reminder','missed_call_recovery','capacity_offer'],required:true},
  template:{type:String,required:true,maxlength:700},
  state:{type:String,enum:['draft','scheduled','processing','sent','completed','paused','suppressed','uncertain','failed','canceled'],default:'draft'},
  approvedBy:{type:String,maxlength:60,default:''},
  approvedAt:{type:Date,default:null},
  executeAt:{type:Date,required:true},
  nextAt:{type:Date,default:null},
  sentCount:{type:Number,min:0,max:3,default:0},
  maxSends:{type:Number,min:1,max:3,default:1},
  intervalHours:{type:Number,min:24,max:720,default:72},
  lockUntil:{type:Date,default:null},
  lockedBy:{type:String,maxlength:100,default:''},
  lastStatus:{type:String,maxlength:100,default:''},
  revision:{type:Number,default:0},
  history:[{at:{type:Date,default:Date.now},status:String,reason:{type:String,maxlength:150}}],
},{timestamps:true});
schema.index({business:1,state:1,executeAt:1});
schema.index({state:1,executeAt:1,lockUntil:1});
schema.index({business:1,opportunity:1,purpose:1},{unique:true});
export default mongoose.models.RevenueAutomationCampaign || mongoose.model('RevenueAutomationCampaign',schema);
