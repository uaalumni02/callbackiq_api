import validateServiceAreaTool from "../helpers/ai/tools/validateServiceArea.tool.js";

const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const postal = (value) => String(value || "").match(/\b\d{5}\b/)?.[0] || "";
const configuredAreas = (business) => {
  const value = business?.aiKnowledge?.verifiedFacts?.serviceAreas?.value;
  const sources = [value, business?.serviceAreas, business?.serviceAreaCities, business?.serviceZipCodes].flat().filter(Boolean);
  return sources.map((item) => normalize(typeof item === "string" ? item : item?.city || item?.postalCode || item?.name));
};

export const checkVoiceServiceArea = async ({ business, location = "", city = "", postalCode = "" }) => {
  const zip = postalCode || postal(location);
  if (zip) {
    const result = await validateServiceAreaTool({ businessId: business?._id || business, postalCode: zip });
    return { ...result, verified: true, postalCode: zip, method: "postal_code" };
  }
  const candidate = normalize(city || location);
  if (!candidate) return { verified: false, supported: null, method: "manual_review" };
  const areas = configuredAreas(business);
  const match = areas.find((area) => area && (area === candidate || area.includes(candidate) || candidate.includes(area)));
  if (match) return { verified: true, supported: true, city: city || location, method: "configured_city" };
  return { verified: false, supported: null, city: city || location, method: "manual_review" };
};

export default { checkVoiceServiceArea };
