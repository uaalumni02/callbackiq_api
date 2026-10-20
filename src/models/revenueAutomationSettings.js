import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 business:{type:Schema.Types.ObjectId,ref:'Business',required:true,unique:true},
 enabled:{type:Boolean,default:false},
 liveSendingEnabled:{type:Boolean,default:false},
 maxMessagesPerDay:{type:Number,min:1,max:25,default:5},
 quietStartHour:{type:Number,min:0,max:23,default:20},
 quietEndHour:{type:Number,min:0,max:23,default:9},
 humanEscalationMinutes:{type:Number,min:5,max:1440,default:60},
 revision:{type:Number,default:0},
},{timestamps:true});
export default mongoose.models.RevenueAutomationSettings || mongoose.model('RevenueAutomationSettings',schema);
