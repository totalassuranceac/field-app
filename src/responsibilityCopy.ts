/**
 * Wording for the company card and company vehicle responsibility forms.
 * A signed row stores this exact text. Later edits do not rewrite old signatures.
 */

export const CARD_FORM_VERSION = "2026-10-09";
export const VEHICLE_FORM_VERSION = "2026-10-09";

export type CardUse = "fuel" | "parts" | "both";

export const CARD_LINES = [
  "I use this card only for company purchases. Personal charges, cash advances, and anything that is not for the job are not allowed.",
  "I do not share the card, the number, or the PIN. Another person does not charge on it unless the office has approved that in writing.",
  "I turn in a receipt for every charge. Fuel is logged on Log fuel. Parts and materials are logged on Purchase receipts.",
  "I tell the office the same day if a charge is wrong, if I cannot find the receipt, or if the card is lost or stolen.",
  "I keep the card with me. I do not leave it in the truck, and I do not photograph the full card number.",
  "I am responsible for charges that are not company business. Total Assurance can require me to repay those charges.",
  "I return the card when my employment ends or when the office asks for it.",
];

export const CARD_CLOSING = "I have read each line. I am the person responsible for this card.";

export const VEHICLE_CLOSING =
  "I have read each line. I will treat every company vehicle I drive this way. Misuse can cost me driving privileges and can lead to discipline, up to losing my job.";

export const VEHICLE_LINES = [
  "I drive a company vehicle only when I am allowed to, and only with a valid driver license.",
  "The vehicle is for company work. Personal use is not allowed.",
  "I follow traffic laws. I wear a seat belt. I do not drive while impaired. I do not hold a phone while the vehicle is moving. Hands-free is allowed only where the law permits it and it is safe.",
  "I am responsible for traffic tickets and for damage that comes from misuse, neglect, or personal use. I report a ticket, a wreck, or new damage the same day.",
  "I report a warning light, a flat tire, or anything that makes the truck unsafe the same day on Truck problem. I complete the weekly check when it is due.",
  "I record fuel honestly on the company fuel card. The miles and the receipt have to match the stop.",
  "I lock the vehicle when I leave it. I do not leave it running with the keys in it. I do not leave tools, parts, or a customer's property unsecured.",
  "I know company vehicles have trackers and cameras. After a wreck I report it immediately and I take the drug and alcohol test the company requires. Refusing the test is treated the same as a failed test.",
  "I do not let an unauthorized person drive the vehicle. I return the keys when my employment ends or when the office asks for them.",
];

export function isCardUse(value: string): value is CardUse {
  return value === "fuel" || value === "parts" || value === "both";
}

export function cardUseLabel(value: string): string {
  if (value === "fuel") return "Fuel";
  if (value === "parts") return "Parts and materials";
  if (value === "both") return "Fuel and parts";
  return "";
}

export function cardShownText(input: { name: string; last4: string; useLabel: string }): string {
  const lines = CARD_LINES.map((line, i) => `${i + 1}. ${line}`).join("\n");
  return [
    "Company credit card responsibility",
    "Total Assurance A/C & Heating",
    "",
    `Employee: ${input.name}`,
    `Card ending: ${input.last4}`,
    `Used for: ${input.useLabel}`,
    `Wording version: ${CARD_FORM_VERSION}`,
    "",
    "I agree to each line below.",
    "",
    lines,
    "",
    CARD_CLOSING,
  ].join("\n");
}

export function vehicleShownText(input: { name: string; vehicleLabel: string }): string {
  const lines = VEHICLE_LINES.map((line, i) => `${i + 1}. ${line}`).join("\n");
  return [
    "Company vehicle use",
    "Total Assurance A/C & Heating",
    "",
    `Employee: ${input.name}`,
    `Vehicles: ${input.vehicleLabel}`,
    `Wording version: ${VEHICLE_FORM_VERSION}`,
    "",
    "I agree to each line below.",
    "",
    lines,
    "",
    VEHICLE_CLOSING,
  ].join("\n");
}
