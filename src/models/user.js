import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/user.js";

const UserSchema = new Schema(
  {
    userName: {
      type: String,
      required: [true, "Please enter a username"],
      trim: true,
      unique: true,
      validate: [validate.isValidUserName, "Please enter a valid username"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      unique: true,
      validate: [validate.isValidEmail, "Please enter a valid email address"],
    },

    password: {
      type: String,
      required: [true, "Password is required"],
    },

    role: {
      type: String,
      enum: ["owner", "admin", "member"],
      default: "owner",
      required: true,
      validate: [validate.isValidRole, "Role must be owner, admin, or member"],
    },

    businessName: {
      type: String,
      required: [true, "Business name is required"],
      trim: true,
      maxlength: 100,
    },

    businessPhone: {
      type: String,
      default: "",
      trim: true,
    },

    businessType: {
      type: String,
      enum: [
        "hvac",
        "plumbing",
        "roofing",
        "electrical",
        "restoration",
        "other",
      ],
      default: "other",
    },
  },
  {
    timestamps: true,
  },
);

UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

const User = mongoose.models.User || mongoose.model("User", UserSchema);

export default User;
