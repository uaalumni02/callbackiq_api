import mongoose from "mongoose";

const { Schema } = mongoose;
const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;

const normalizeZipCodes = (values = []) =>
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter((value) => ZIP_PATTERN.test(value)),
  )].sort();

const ServiceAreaSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["zip_codes", "radius", "unrestricted"],
      default: "zip_codes",
    },
    zipCodes: {
      type: [String],
      default: [],
    },
    centerPostalCode: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator(value) {
          return !value || ZIP_PATTERN.test(value);
        },
        message: "centerPostalCode must be a valid US ZIP code",
      },
    },
    radiusMiles: {
      type: Number,
      min: 1,
      max: 500,
      default: 25,
    },
  },
  { timestamps: true },
);

ServiceAreaSchema.pre("validate", function normalizeServiceArea() {
  this.zipCodes = normalizeZipCodes(this.zipCodes);
});

const ServiceArea =
  mongoose.models.ServiceArea || mongoose.model("ServiceArea", ServiceAreaSchema);

export default ServiceArea;
