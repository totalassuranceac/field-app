import type { Role } from "./api";

/** Who the guide is written for (viewer uses admin browse guides as read-only). */
export type HowToAudience = Role | "everyone";

export type HowToGuide = {
  id: string;
  title: string;
  /** Short one-liner under the title */
  summary: string;
  /** Roles that should see this by default */
  roles: HowToAudience[];
  /** Deep link into the app when useful */
  path?: string;
  /** Numbered steps */
  steps: string[];
  tips?: string[];
};

export const HOWTO_ROLES: { id: HowToAudience; label: string; blurb: string }[] = [
  {
    id: "everyone",
    label: "Everyone",
    blurb: "Basics that apply no matter your role.",
  },
  {
    id: "driver",
    label: "Field",
    blurb: "Techs on the truck — fuel, checks, repairs, warranties, gear.",
  },
  {
    id: "warehouse",
    label: "Warehouse",
    blurb: "Parts, stock, pickups, bottles, and truck equipment.",
  },
  {
    id: "mechanic",
    label: "Mechanic",
    blurb: "Shop repairs, service, yard, and fleet flags.",
  },
  {
    id: "office",
    label: "Office",
    blurb: "Map, scheduled work, people, inventory overview.",
  },
  {
    id: "admin",
    label: "Admin",
    blurb: "Full company setup — accounts, settings, handbook, roles.",
  },
  {
    id: "viewer",
    label: "Viewer",
    blurb: "Same screens as Admin, look only — no changes.",
  },
];

/**
 * Practical how-tos matching current Field App screens.
 * Keep language plain; field staff open this when stuck.
 */
export const HOWTO_GUIDES: HowToGuide[] = [
  // ——— Everyone ———
  {
    id: "sign-in",
    title: "Sign in the first time",
    summary: "Use the invite link from your admin — not a temporary password.",
    roles: ["everyone"],
    path: "/login",
    steps: [
      "Open the join link your admin texted or emailed (it looks like …/join/…).",
      "Type the exact username they gave you (usually all lowercase).",
      "Create a password (at least 8 characters) and confirm it.",
      "You are signed in right away. Next time, use Sign in with that username and password.",
    ],
    tips: [
      "If the link is expired or already used, ask Admin → Invite for a new one.",
      "Forgot password? Ask admin for a new join link — they should not text a shared temp password.",
    ],
  },
  {
    id: "app-feedback",
    title: "Send app feedback",
    summary: "Suggest improvements or report something that is hard to use.",
    roles: ["everyone"],
    path: "/feedback",
    steps: [
      "Open App feedback under Company.",
      "Pick a type (suggestion, bug, praise, or other).",
      "Write what would help — which screen if you can.",
      "Send — office and admin see it in their feedback inbox.",
    ],
    tips: [
      "No idea is too small. Specific examples help us fix things faster.",
    ],
  },
  {
    id: "menu-nav",
    title: "Find your way around",
    summary: "Menu on the left (desktop) or the menu button (phone).",
    roles: ["everyone"],
    steps: [
      "On a phone, tap the menu (☰) at the top to open navigation.",
      "Menus are grouped like Command Center: Fleet, Warehouse, Shop, and Company — tap a group to expand it.",
      "Your Home screen shows what needs attention for your role (field techs also get a Today’s checklist).",
      "Tap your name at the bottom of the menu for Settings and sign out.",
      "The inbox icon shows notifications — tap one to jump to the related page.",
    ],
    tips: [
      "You only see links for what your role is allowed to do; empty groups hide.",
      "If you see “Saved offline” or “waiting to send,” your work is on this phone until signal returns — not lost.",
    ],
  },
  {
    id: "notifications",
    title: "Notifications & alerts",
    summary: "Repairs, warranties, weekly checks, pickups, equipment, and handbook.",
    roles: ["everyone"],
    path: "/notifications",
    steps: [
      "Open Notifications from the menu (or the inbox icon).",
      "Unread subjects are bold; swipe left to mark read, or use Mark all read.",
      "Tap a notification to open the related screen (warranty, pickup, weekly check, etc.).",
      "Warehouse/admin may also get alerts for aging warranties, open pickups, and equipment that needs attention.",
      "Shop/office can use Send weekly check reminders to nudge field techs overdue on weekly truck checks.",
    ],
    tips: [
      "Mileage / fuel oddities are under Alerts (Fleet). Warranty work is under Warranties (Warehouse).",
    ],
  },
  {
    id: "handbook",
    title: "Read and acknowledge the handbook",
    summary: "Company policies in searchable sections — confirm after you read.",
    roles: ["everyone"],
    path: "/handbook",
    steps: [
      "Open Handbook from the menu.",
      "Search (sick, overtime, vehicle…) or tap a section, then open a topic.",
      "Read on your phone — use Previous / Next to move between topics.",
      "If confirmation is required, check I have read and understand, then Submit confirmation.",
      "Only admin can clear an acknowledgment if someone must re-read.",
    ],
    tips: [
      "Quick answers at the top jump straight to common topics like sick days and company vehicles.",
    ],
  },
  {
    id: "new-hire-packet",
    title: "Print a new hire packet",
    summary: "One button from People — checklist, application, W-4, I-9, deposit, emergency contact.",
    roles: ["office", "admin", "supervisor"],
    path: "/onboarding",
    steps: [
      "Open People (Admin) and tap New hire packet.",
      "Optional: type the hire’s name, position, and start date so the letterhead is personalized.",
      "Tap Print full hire packet — one job includes company forms plus official W-4 and I-9.",
      "Before they leave: photocopy driver’s license and Social Security card (MUST COLLECT on the checklist).",
      "Send their Field App invite and have them read/confirm the Handbook.",
    ],
    tips: [
      "Wait for “Loading W-4 & I-9…” then the print dialog — preview should show company pages then W-4 then I-9.",
      "Each January, download the new IRS W-4 and use Replace W-4 / I-9 so blanks stay current.",
      "Do not recreate W-4 or I-9 yourself — always use the official IRS / USCIS PDF.",
    ],
  },
  {
    id: "time-off",
    title: "Time Off Request",
    summary: "Ask for days off in the app; your manager approves or declines with remarks.",
    roles: ["everyone"],
    path: "/time-off",
    steps: [
      "Open Time Off Request under Company in the menu.",
      "Choose type (PTO, sick, personal, unpaid, or other), start and end dates, and an optional reason.",
      "Tap Submit for approval — your manager (or office/admin if none is set) is notified.",
      "When they decide, you get a notification. Open Time Off Request to see Approved/Declined and any remarks.",
      "Managers: use the Approvals tab to approve or decline with optional remarks for the employee.",
    ],
    tips: [
      "Admin should set each person’s Manager under People so requests route to the right person.",
      "You can cancel a request while it is still Pending.",
    ],
  },
  {
    id: "tool-loan",
    title: "Tool Loan Request",
    summary:
      "Ask for a company tool loan for field work. Weekly deduction is 10% of the loan (minimum $50). Office tracks: approved → ordered → arrived → paperwork signed (with optional signed form scan).",
    roles: ["everyone"],
    path: "/tool-loans",
    steps: [
      "Open Tool Loan Request under Company.",
      "Enter tool/part name, loan amount, and how it helps company field work. Product link is optional but preferred.",
      "Read the terms: 10% weekly (min $50). Higher loans = higher weekly payments. Only request what you need for the job.",
      "Submit — office reviews. You get a notification when approved or declined.",
      "On My requests, watch the progress bar: Requested → Approved → Ordered → Arrived (with dates).",
      "Office/admin: Approvals → Approve/Decline. After approve, Parts to track → Mark ordered, then Mark arrived (optional note for tracking #).",
    ],
    tips: [
      "Loans are for company field tools only — not personal spending. The company is not a bank.",
      "Example: $400 → $50/week (minimum); $600 → $60/week; $1,000 → $100/week.",
      "You are notified when office marks Ordered and when the part Arrives.",
    ],
  },
  {
    id: "tool-loan-ledger",
    title: "Tool loan balances (office)",
    summary:
      "Track what each person owes: record charges and payroll/spiff payments, download the weekly sheet for the owner.",
    roles: ["admin", "office"],
    path: "/tool-loan-ledger",
    steps: [
      "Open Tool loan payroll (office/admin only).",
      "Review the owner payroll report: amount owed and suggested weekly deduction per employee.",
      "Print weekly report for payroll.",
      "In Bulk weekly payroll deductions: everyone is checked with policy amounts. Uncheck anyone to skip, change an amount if needed, then click Apply bulk weekly deductions once.",
      "To put an unapproved card charge (or any loan) on someone — even with $0 balance — use Add loan charge (no approval): pick employee, reason, amount, then Add charge & print acknowledgment for their signature.",
      "Open a person for payment history, re-print an acknowledgment, or set an optional default weekly amount.",
    ],
    tips: [
      "Balances are calculated (charges − payments). History is permanent.",
      "Office charges do not go through the employee request / approval flow.",
      "Recording weekly deductions is separate from the owner report — the report shows what to take; bulk apply logs what was actually taken.",
      "Spiff payments show in blue type so they stand out from payroll deductions.",
      "Former employees are excluded from the weekly payroll list; balances stay on file.",
      "Activate/deactivate logins in People & settings when someone leaves or returns.",
    ],
  },
  {
    id: "settings-password",
    title: "Change your password or phone",
    summary: "Keep your login secure and contact info current.",
    roles: ["everyone"],
    path: "/settings",
    steps: [
      "Open Settings (tap your name in the sidebar).",
      "Update phone — office / warehouse / shop use it for Call on Live map when they find you by name.",
      "Use Change password with your current password, then a new one.",
      "Sign out from the same screen when you leave a shared device.",
    ],
    tips: [
      "Without a phone on file, Call on Live map stays disabled for your unit (office/shop still see you on the map).",
    ],
  },
  {
    id: "offline-saves",
    title: "Working with weak or no signal",
    summary: "Saves stay on the phone until they can send.",
    roles: ["everyone", "driver"],
    path: "/",
    steps: [
      "If you see “Saved offline” or “waiting to send,” your work is on this phone — not lost.",
      "Keep using the app; fuel, drop-offs, and other queued saves send when signal returns.",
      "When online again, the yellow banner shows how many are waiting; tap Retry if stuck.",
      "Don’t clear browser data for the app until the queue is clear.",
    ],
  },

  // ——— Field ———
  {
    id: "field-home",
    title: "Field Home — today’s checklist",
    summary: "See what still needs you: weekly check, repairs, fuel, warranties, pickups.",
    roles: ["driver"],
    path: "/",
    steps: [
      "Open Home after sign-in.",
      "Use Today’s checklist — open items are highlighted; completed weekly checks show done.",
      "Tap a row to jump to Weekly checks, Repairs, Fuel, Warranties, or Part pickup.",
      "Hot pills (unit check due, open repairs) appear when something needs action now.",
    ],
  },
  {
    id: "field-fuel",
    title: "Log fuel after a fill-up",
    summary: "Photo the receipt — the app fills gallons, total, and card digits.",
    roles: ["driver", "office", "admin", "mechanic", "warehouse"],
    path: "/fuel",
    steps: [
      "Open Log fuel (Fleet / menu — available to field, warehouse, shop, and office).",
      "Your usual unit is selected by default when you’re a tech. Anyone can pick any active van.",
      "If you’re not the driver on the truck, choose who fueled (Driver list).",
      "Take a photo of the full receipt (or pick one from gallery).",
      "Confirm gallons, total cost, last 4 of card, and odometer — fix anything the scan missed.",
      "Add a short note if the odometer looks wrong or the pump failed (optional).",
      "Submit. Mileage flags may appear later if miles look off — office/shop will review those.",
    ],
    tips: [
      "Fill the frame · flat lighting · no glare on shiny paper · hold still.",
      "Helpers can always log fuel on any active van — not only the tech they usually ride with.",
      "If you are offline, the log queues and sends when you have signal again.",
    ],
  },
  {
    id: "field-weekly",
    title: "Complete a weekly truck check",
    summary: "Walk the truck checklist so the shop knows the unit is ready.",
    roles: ["driver", "mechanic", "admin"],
    path: "/inspections",
    steps: [
      "Open Weekly checks (Fleet menu).",
      "Select your truck / unit.",
      "Go through each item — pass or flag problems.",
      "Add notes or photos if something is wrong.",
      "Submit the check so Home stops showing it as due.",
    ],
  },
  {
    id: "field-repair",
    title: "Request a repair",
    summary: "Tell the shop what is wrong and how urgent it is.",
    roles: ["driver", "mechanic", "office", "admin"],
    path: "/issues",
    steps: [
      "Open Request repair (Shop menu).",
      "Choose the unit and describe the problem clearly (what, where, when it started).",
      "Pick severity / urgency so the shop can prioritize.",
      "Add photos if they help (leak, dash light, damage).",
      "Submit. When the shop books a day, you get a notification (and SMS if set up) — open the app and tap Confirm appointment.",
      "If you cannot make that date, tap Can’t make it and leave a short reason so the shop can reschedule.",
    ],
    tips: [
      "If it is unsafe to drive, say so in the description and contact shop/dispatch by phone too.",
      "Home checklist shows Confirm shop appointment until you accept. Shop can see who confirmed and who did not.",
    ],
  },
  {
    id: "plate-lookup",
    title: "Find a unit by license plate",
    summary:
      "Type a plate (or unit #) on fuel, repairs, service, or parts order forms — the app fills unit, year/make/model, and driver.",
    roles: ["mechanic", "driver", "office", "admin", "warehouse"],
    path: "/fuel",
    steps: [
      "On any form that asks for a vehicle, use License plate or unit #.",
      "Type the plate (spaces/dashes optional) or the unit number.",
      "When it matches, unit details appear — confirm, then continue the form.",
      "If several match, tap the right one. Or use Or pick unit under the field.",
    ],
    tips: [
      "Plate data comes from the fleet registry — keep plates updated under Vehicles.",
      "On oil change log, matching a unit can also suggest the current odometer.",
    ],
  },
  {
    id: "parts-delivery-run",
    title: "Warehouse delivery request",
    summary:
      "Need materials brought to a job? Request a delivery, explain why it wasn’t on the truck, and keep a shared log.",
    roles: ["everyone"],
    path: "/parts-runs",
    steps: [
      "Open Warehouse delivery request under Warehouse.",
      "Describe what you need.",
      "Say why it wasn’t already on the truck.",
      "Enter the address / job site it needs to go to — submit.",
      "Warehouse: Open runs → On the way → Delivered when it’s out.",
    ],
    tips: [
      "Be specific in the description so warehouse knows what to grab.",
      "A clear address (or meetup spot) speeds the run.",
    ],
  },
  {
    id: "shop-parts-order",
    title: "Order parts (AutoZone / First Call)",
    summary:
      "Open AutoZone Pro or First Call Online from the app, log what you need, track Needed → Ordered → Arriving → Received.",
    roles: ["mechanic", "office", "warehouse", "admin"],
    path: "/parts-orders",
    steps: [
      "Open Order parts under Shop.",
      "Type the vehicle plate (or unit #) — when it matches, the plate is copied to the clipboard automatically.",
      "Open AutoZone or First Call → click their plate field → Ctrl+V (already ready; no extra copy button).",
      "If paste is empty, use Copy again on the yellow bar.",
      "Save the part on the order list, then Mark ordered / Arriving / Received as it moves.",
    ],
    tips: [
      "Their catalogs don’t let us pre-fill the plate in the link — auto-copy on select + paste is the workaround.",
      "After you buy, log the invoice under Parts receipts if it was a company card.",
    ],
  },
  {
    id: "field-warranty",
    title: "Drop off a warranty part",
    summary:
      "Part name + equipment unit model/serial (not the part) · unit nameplate photo helps · log number on the box.",
    roles: ["driver", "warehouse", "office", "admin"],
    path: "/warranties",
    steps: [
      "Open Warranties (Warehouse menu).",
      "Step 1 — Equipment: enter model # and serial # from the unit nameplate the part came off of (optional nameplate photo auto-fills).",
      "Step 2 — Warranty part: enter the failed part name (and optional SKU).",
      "Step 3 — Job details if you have them (address helps warehouse later).",
      "Step 4 — Photo the shelf or bin where you leave the part (required).",
      "Submit — a popup shows the warranty log number (e.g. W0726-001).",
      "Write that number on the box, then tap Got it — take me home.",
    ],
    tips: [
      "Section 1 is always the equipment unit; section 2 is the part on the box — don’t mix them up.",
      "Do not skip the number on the box — warehouse matches it to your drop-off photo.",
      "When you fix a wrong model/serial from a nameplate scan, the app learns for next time.",
      "Warehouse: if something should leave the open list without Approved/Rejected (back to shelves, another job, not a claim), use Remove from open list — no reason required.",
      "While a claim is open, use Status notes → Add update so everyone can see progress (e.g. working with Lennox). Each save stamps your name and time.",
    ],
  },
  {
    id: "field-parts-receipt",
    title: "Submit a parts purchase receipt",
    summary:
      "Photo the invoice, link it to the vehicle you worked on — all parts for that unit stay together.",
    roles: ["driver", "mechanic", "warehouse", "office", "admin"],
    path: "/parts-receipts",
    steps: [
      "On the shop board, open the job (In progress or Completed).",
      "Parts for unit shows open orders — mark Ordered / Arriving / Received without leaving.",
      "Upload parts receipts on the same screen (tied to that unit + ticket).",
      "On Complete job: if no receipt yet, you’ll get a soft confirm — complete anyway if nothing was bought.",
      "After complete, use Unit parts history to review all receipts for that vehicle.",
    ],
    tips: [
      "Multi-day jobs: upload receipts while In progress, not only on the last day.",
      "Each correction you make teaches the scanner where invoice # and vendor sit on that vendor’s slip.",
    ],
  },
  {
    id: "field-gear",
    title: "Check gear on my truck",
    summary: "See bottles and equipment assigned to your unit.",
    roles: ["driver", "mechanic", "admin"],
    path: "/assets",
    steps: [
      "Open My truck gear (Assets / Warehouse menu).",
      "Bottles and equipment are grouped by location — tap a group to expand.",
      "Report condition issues (damage, missing pads, etc.) if the form allows.",
      "Need a bottle swap or new ladder? Talk to warehouse — they issue and return assets.",
    ],
  },
  {
    id: "live-map-find-tech",
    title: "Find a tech on Live map — Map or Call",
    summary: "Search by name, then open directions or dial them without knowing the number.",
    roles: ["office", "warehouse", "mechanic", "supervisor", "admin"],
    path: "/live",
    steps: [
      "Open Live map (Fleet menu). Field techs do not see this map.",
      "Type the tech’s name in Find tech by name… (above the map).",
      "When their unit is selected, tap Map for turn-by-turn to their GPS, or Call to dial their phone on file.",
      "You can also tap a row in the vehicle list, then use Map or Call on that row.",
      "Pin popups also offer Map and Call links.",
    ],
    tips: [
      "Call needs a phone on their user or employee record (Settings / People).",
      "Search also works for unit numbers (e.g. 004).",
      "Live map is limited to supervisors, warehouse, shop, and office.",
    ],
  },

  // ——— Warehouse ———
  {
    id: "wh-inventory",
    title: "Work inventory (stock, pickup, order)",
    summary: "Main warehouse screen — tabs for day-to-day parts work.",
    roles: ["warehouse", "admin", "office"],
    path: "/inventory",
    steps: [
      "Open Inventory (Warehouse menu).",
      "Use the tabs: Stock, Pickup (issue to tech), Order / stage, History, Catalog as needed.",
      "Search by part name or code; open a part for barcodes, vendors, min/max, and location stock.",
      "Scan to receive: camera (or USB scanner) finds the part, then + Receive at a location.",
      "Print barcode folder list from Stock for a binder of part # + scannable barcodes.",
      "Office can usually browse; only warehouse/admin should change quantities.",
    ],
    tips: [
      "Link package UPCs on each part page so Scan to receive finds manufacturer barcodes.",
      "Truck stock lines come from the pricebook — do not invent random SKUs on trucks.",
    ],
  },
  {
    id: "wh-pickup",
    title: "Issue parts to a tech, then scan truck",
    summary: "Stage all parts for a tech, then scan the unit barcode to move stock.",
    roles: ["warehouse", "admin"],
    path: "/inventory",
    steps: [
      "Open Inventory → Pickup.",
      "Select the tech the parts are for.",
      "Scan every part (or type part #) into the list; adjust qty if needed.",
      "Optional: put job address or ticket # in Notes (helps the pickup log later).",
      "Tap Stage issue for tech — list shows as ready for truck.",
      "Open that issue → Scan truck (unit # like 001) or type unit number → confirm.",
      "Stock leaves warehouse and goes on that truck; custody is recorded.",
    ],
    tips: [
      "Truck scan matches unit number (001, Unit 001). Print unit barcodes for each truck if helpful.",
      "You can still pick a truck from “Or pick truck from list.”",
    ],
  },
  {
    id: "wh-truck-count",
    title: "Truck stock count (first baseline)",
    summary:
      "Techs count what is on their truck; check “don’t need” for parts they skip; sign; warehouse applies to inventory.",
    roles: ["everyone"],
    path: "/truck-stock",
    steps: [
      "Warehouse or office: open Truck stock count → open a sheet for one unit or all active trucks.",
      "Tech: open your unit’s sheet, type a count for each part.",
      "Check “Skip / don’t need” if you have no room or won’t use that part on this truck.",
      "Confirm accuracy, type your name to sign, Submit.",
      "Warehouse: open submitted sheets → Apply to truck stock (updates inventory for replenishment).",
    ],
    tips: [
      "Only catalog parts marked as truck stock appear on the sheet.",
      "Office can fill or sign for a tech if needed.",
    ],
  },
  {
    id: "wh-vendor-runs",
    title: "Part pickup request",
    summary:
      "Parts ready at a store? Request a pickup — store name, what the part is, and where it needs to go.",
    roles: ["everyone"],
    path: "/part-pickup",
    steps: [
      "Open Part pickup request under Warehouse.",
      "Enter the store / vendor (Gemaire, Johnstone, etc.).",
      "Describe the part and the address it’s needed for.",
      "Office/admin: also pick the contact person if logging for someone else.",
      "Submit — warehouse sees open requests by store and marks them picked up.",
    ],
    tips: [
      "If you already picked up and left parts at the shop, use Brought to shop instead.",
    ],
  },
  {
    id: "wh-parts-dropoff",
    title: "Parts drop-off — parts already at the shop",
    summary:
      "When someone picks up from a vendor while they’re out and leaves the parts at the shop, log a drop-off so warehouse knows they’re ready to put away or issue.",
    roles: ["everyone"],
    path: "/parts-dropoff",
    steps: [
      "Open Parts drop-off (Warehouse menu).",
      "Enter vendor, what’s in the drop-off, and optional unit/job + where you left them.",
      "Optional: add part # / description lines for each piece.",
      "Tap Log drop-off at shop — warehouse gets a notification.",
      "Warehouse taps Received · ready to issue when they have the parts.",
    ],
    tips: [
      "Use Part pickup request when parts are still at a store waiting to be collected.",
      "Use Brought to shop when the parts are already on the counter / in the cage at the shop.",
    ],
  },
  {
    id: "wh-bottles",
    title: "Bottles and company equipment",
    summary: "Check out, return, and swap tanks, ladders, and tagged gear.",
    roles: ["warehouse", "admin", "office"],
    path: "/assets",
    steps: [
      "Open Company assets (Warehouse menu).",
      "Bottle totals sit at the top; Warehouse swap and Set counts are collapsible tools.",
      "Equipment groups by person first (With Adam…), then warehouse available gear.",
      "To return: open the person → tap the item or Return → set condition + date → Mark returned → warehouse.",
      "To check out: open available gear → pick person (and optional truck) + condition + date → Check out.",
      "Transfer hands gear person-to-person without a warehouse stop; Condition logs damage only.",
    ],
  },
  {
    id: "wh-warranty-recv",
    title: "Process a warranty drop-off",
    summary: "Find the part, track return-to-vendor, credit, and search by address or log #.",
    roles: ["warehouse", "admin", "office", "mechanic"],
    path: "/warranties",
    steps: [
      "Open Warranties — use Open for active claims.",
      "Use Search (log # like 005, street like tallow, part name, RMA) — search looks across all statuses.",
      "Use the drop-off photo and note to find the part on the shelf.",
      "Update path: Dropped off → Claim submitted → optional Return to vendor → Delivered → Approved or Rejected.",
      "Return to vendor stays open until Approved or Rejected (credit decision).",
      "On vendor path: enter RMA #, tracking #, and credit $ when you have them; use Waiting on vendor filter.",
      "Only Approved / Rejected remove a claim from the open list.",
    ],
    tips: [
      "Don’t know the vendor? Inventory → Pickup → “Where did we buy this?” by address, or Pickup log by part #.",
    ],
  },

  // ——— Mechanic ———
  {
    id: "mech-shop",
    title: "Work the repair board",
    summary: "Schedule, update, and close shop work. Log work you did without a driver ticket.",
    roles: ["mechanic", "office", "admin", "supervisor"],
    path: "/issues",
    steps: [
      "Open Repairs & shop.",
      "Filter open / scheduled work for your bay or day.",
      "Set Scheduled and pick the date the van should come in — the tech gets an app alert + SMS to CONFIRM.",
      "Watch badges: Awaiting confirm / Confirmed / Declined. If a van no-shows, check whether they confirmed.",
      "If the app says no user is linked to the unit, call them and fix the assigned driver under Vehicles.",
      "Mark In progress only when the unit is actually in the bay (that marks it out of service).",
      "Record what you fixed and parts used when closing — tech is notified when done or cancelled.",
      "Did work with no driver ticket? Use Log shop work — pick the unit, concerns, work performed, and mark Completed (or In progress).",
      "When a job is finished, Print tech receipt and hand the slip to the tech (unit, work done, parts, sign-off lines).",
      "Supervisors: open Done today (or pick a date) to see completed work; use Print day log for a printable list of that day’s jobs.",
    ],
    tips: [
      "Booking a future date does not take the truck off the road — only In progress does.",
      "Changing the shop date resets confirmation — the tech must confirm the new appointment.",
      "Shop-logged jobs skip tech appointment confirm — they are already in the bay or already done.",
      "Print work order = open / scheduled jobs for the bay. Print tech receipt = one completed job for the driver.",
    ],
  },
  {
    id: "mech-service",
    title: "Log oil / service",
    summary: "Track PM and service events on units.",
    roles: ["mechanic", "admin", "office"],
    path: "/service",
    steps: [
      "Open Oil / service (Shop menu for admin).",
      "Review what is due if the due list is shown.",
      "Add a service record for the unit (type, miles/date, notes).",
      "Update when complete so reports stay accurate.",
    ],
  },
  {
    id: "dump-runs",
    title: "Log a dump run",
    summary: "Photo the landfill ticket; record net weight and total. OCR learns from your fixes.",
    roles: ["warehouse", "mechanic", "admin"],
    path: "/dump-runs",
    steps: [
      "Open Dump runs (Warehouse or Shop menu).",
      "Take a photo of the full scale ticket / receipt.",
      "Check net weight (lbs) and total $ — fix anything OCR missed.",
      "Save. The app learns corrections so the next similar ticket fills faster.",
    ],
    tips: [
      "Hold the ticket flat with little glare so weight and total read cleanly.",
    ],
  },
  {
    id: "mech-yard",
    title: "Yard walk",
    summary: "See which units are in the yard and their status.",
    roles: ["mechanic", "office", "admin"],
    path: "/yard",
    steps: [
      "Open Yard walk.",
      "Scan units present vs expected.",
      "Flag problems or open a repair if something is broken in the yard.",
    ],
  },
  {
    id: "mech-flags",
    title: "Mileage flags (odometer alerts)",
    summary: "Review fuel logs that look wrong.",
    roles: ["mechanic", "office", "admin"],
    path: "/alerts",
    steps: [
      "Open Mileage flags.",
      "Read the message (jump in miles, low mpg, etc.).",
      "Talk to the tech if needed, then acknowledge / clear when resolved.",
    ],
  },

  // ——— Office ———
  {
    id: "office-home",
    title: "Office home & live map",
    summary: "Day view of trucks, repairs, and open items.",
    roles: ["office", "admin"],
    path: "/",
    steps: [
      "Home (Command center for admin) shows counts that need attention.",
      "Open Live map — search a tech by name, then Map or Call (phone from their profile).",
      "Jump into Scheduled repairs for the repair calendar / list.",
      "Open TV board on the office TV (full screen / F11) for a live glance at shop + counts.",
      "Use Inventory to browse stock; warehouse changes quantities.",
      "Warranties: search by address or log #; process claim / vendor return statuses.",
    ],
    tips: [
      "TV board: sign in as office/admin on the TV browser, open /tv, leave it full screen. It refreshes itself.",
    ],
  },
  {
    id: "office-people",
    title: "People — employees and logins",
    summary: "Keep the roster and Field App accounts matched.",
    roles: ["office", "admin"],
    path: "/admin",
    steps: [
      "Open People (Company → People & settings).",
      "Add everyone as an Employee even before they have a login.",
      "Create a login with a username; leave password blank to get a join link.",
      "Copy the invite link (banner stays until you dismiss it) and send it — they set their own password.",
      "Link employee ↔ user if they were created separately; set role (Field, Warehouse, etc.).",
      "Mistyped username? Edit login → fix username → Save & resend invite.",
      "Pending setup rows show Resend for a new join link anytime.",
      "Add phone numbers so Live map Call works for that person.",
    ],
    tips: [
      "Search logins by name, @username, or email at the top of the users list.",
      "Do not share one password for multiple people.",
    ],
  },

  // ——— Admin ———
  {
    id: "admin-accounts",
    title: "Create accounts with invite links",
    summary: "Preferred way — no temporary passwords.",
    roles: ["admin"],
    path: "/admin",
    steps: [
      "People → Users: display name + username, role, optional employee link.",
      "Leave password blank → create → copy the join link (banner stays until dismissed).",
      "Send link + username. User opens link, types username, sets password, is signed in.",
      "Edit login anytime to fix username; Save & resend invite if they never finished setup.",
      "Resend on the user row re-issues a join link (clears password until they finish).",
    ],
  },
  {
    id: "admin-roles",
    title: "Understand roles & preview screens",
    summary: "See what Field vs Warehouse vs Office actually see.",
    roles: ["admin"],
    path: "/roles",
    steps: [
      "Open Role simulator (Company menu) for the permission matrix.",
      "Use View as in the top bar to preview another role’s menus.",
      "Exit View as when done — server still treated you as admin while previewing.",
      "Assign real roles carefully: Field = truck tech, Warehouse = parts, Mechanic = shop, Office = dispatch/ops, Viewer = read-only tour.",
    ],
  },
  {
    id: "admin-handbook",
    title: "Publish handbook versions",
    summary: "Upload PDF and track who has acknowledged.",
    roles: ["admin", "office"],
    path: "/handbook",
    steps: [
      "Open Handbook as admin/office.",
      "Upload a new PDF version with a clear version label.",
      "Staff read and check the acknowledgment after reading.",
      "Review who is still pending; only admin should clear acks when a new mandatory version ships.",
    ],
  },
  {
    id: "admin-settings",
    title: "Company settings & integrations",
    summary: "System options, ServiceTitan, and audit trail.",
    roles: ["admin"],
    path: "/settings",
    steps: [
      "Settings holds company-level options you are allowed to change.",
      "People & settings on Admin also covers ST credentials and related tools.",
      "Audit log (Company) shows who changed what when something looks wrong.",
    ],
  },
  {
    id: "admin-fleet",
    title: "Fleet overview (vehicles, reports, downtime)",
    summary: "Keep the truck list and history healthy.",
    roles: ["admin", "office", "mechanic"],
    path: "/vehicles",
    steps: [
      "Vehicles: unit list, assignments, status (not retired).",
      "Reports: fuel and activity summaries for management.",
      "Downtime: track when units were out of service.",
      "Fuel log: review history; edit only if your role allows corrections.",
    ],
  },

  // ——— Viewer ———
  {
    id: "viewer-browse",
    title: "Browse as Viewer (read-only)",
    summary: "Same layout as Admin — you cannot save or submit changes.",
    roles: ["viewer", "admin"],
    path: "/",
    steps: [
      "Use the full admin-style menu to explore Fleet, Warehouse, Shop, and Company.",
      "A yellow bar reminds you that Viewer is look-only.",
      "If a button does nothing or returns an error, that is expected for writes.",
      "Ask an admin when something needs to be changed for real.",
    ],
  },

  // ——— Who can do what ———
  {
    id: "roles-who-can",
    title: "Who can do what (by role)",
    summary: "Quick map so nobody hunts for a button they can’t use.",
    roles: ["everyone", "admin", "office", "warehouse", "driver", "mechanic"],
    path: "/howto",
    steps: [
      "Field: fuel receipts, weekly checks, warranty drop-off, request repair, truck gear, parts receipts (no live map).",
      "Warehouse: inventory, scan-to-receive, issue-to-tech + truck scan, pickup log, bottles, warranties, live map, log fuel receipts.",
      "Mechanic: shop repairs, oil/service, yard walk, fleet flags, vehicles, weekly checks, live map, log fuel receipts.",
      "Office / supervisor: live map Map/Call, fuel, scheduled repairs, people, inventory overview, warranties, reports.",
      "Admin: everything + invite/resend, role simulator, audit, settings.",
      "Viewer: same screens as admin, cannot save or submit.",
    ],
    tips: [
      "Menus are grouped Fleet · Warehouse · Shop · Company for every role — empty groups hide.",
      "Admin can use View as to preview another role’s menus without changing their real login.",
    ],
  },
  {
    id: "inv-scan-receive",
    title: "Scan barcode to receive stock",
    summary: "Warehouse: camera scan opens the part, then + Receive.",
    roles: ["warehouse", "admin"],
    path: "/inventory",
    steps: [
      "Open Inventory → Stock.",
      "Tap Scan to receive (camera).",
      "Point at the part barcode or QR — the app looks up part # or a linked barcode.",
      "Confirm location, set quantity, tap + Receive.",
      "If the code isn’t found, open the part and use Scan barcode to link first.",
    ],
    tips: [
      "Works best in Chrome on Android with a clear barcode; iPhones may open the camera photo fallback.",
      "USB/Bluetooth wedge scanners that type into the search box also work.",
    ],
  },
  {
    id: "inv-link-barcode",
    title: "Link a package barcode to a part",
    summary: "On the part page, scan the UPC so future receives find this part.",
    roles: ["warehouse", "admin"],
    path: "/inventory",
    steps: [
      "Open Inventory → find the part → open it.",
      "Under Barcodes for this part, tap Scan barcode to link.",
      "Point at the package/vendor barcode (or type the UPC and tap Add).",
      "The code is saved on this part only.",
      "Later, Scan to receive with that barcode opens the same part.",
    ],
    tips: [
      "Part number already works if you print labels with that code — linking is for manufacturer UPCs that differ.",
      "One barcode can only belong to one part; remove it first if you linked the wrong item.",
    ],
  },
  {
    id: "inv-print-barcode-folder",
    title: "Print barcode folder list",
    summary: "All part numbers with scannable barcodes for a warehouse binder.",
    roles: ["warehouse", "admin", "office"],
    path: "/inventory",
    steps: [
      "Open Inventory → Stock.",
      "Tap Print barcode folder list.",
      "Allow the pop-up window, then print (or save as PDF).",
      "Each row: part # and name on the left, barcode of the part # on the right.",
      "Linked package UPCs print under the name when you’ve linked them on the part.",
      "Keep the pages in a warehouse folder for missing boxes / damaged labels.",
    ],
  },
  {
    id: "inv-purchase-by-address",
    title: "Find where we bought a warranty part (by address)",
    summary: "Type the job address on Pickup to see vendor will-calls and warranty vendors.",
    roles: ["warehouse", "admin", "office"],
    path: "/inventory",
    steps: [
      "Open Inventory → Pickup.",
      "Under Where did we buy this?, type the service address or street name (e.g. tallow).",
      "Tap Look up.",
      "Check Vendor will-call / runs first — that shows who we ordered from for that job.",
      "Warranties at this address show vendor if it was filled in at drop-off.",
      "Completed pickup log entries and catalog vendors appear when they match.",
    ],
    tips: [
      "Works best when vendor runs and warranties include the job address.",
      "Use a short street fragment if the full address doesn’t match.",
    ],
  },
  {
    id: "inv-pickup-log-search",
    title: "Search the completed pickup log",
    summary: "After parts go on a truck, find them later by part # or vendor when processing warranties.",
    roles: ["warehouse", "admin", "office"],
    path: "/inventory",
    steps: [
      "Open Inventory → Pickup → Pickup log.",
      "Type part number, catalog vendor, tech name, truck unit, or job notes.",
      "Open a match to see all lines, vendor next to each part, and which truck they went on.",
      "Use this when a warranty part has no vendor written on the box.",
    ],
  },
  {
    id: "warranty-vendor-credit",
    title: "Warranty return to vendor & credit",
    summary: "Return to vendor stays open until Approved or Rejected.",
    roles: ["warehouse", "admin", "office", "mechanic"],
    path: "/warranties",
    steps: [
      "Claims stay on Open until credit is decided — Return to vendor is not Rejected.",
      "Mark Return to vendor when the part ships back; add RMA # and tracking if known.",
      "Use Waiting on vendor filter for those claims only.",
      "Search works across all statuses (log #, street, part, RMA).",
      "When credit arrives: enter Credit $, then Approved or Rejected.",
      "Only Approved / Rejected close the claim.",
    ],
  },
];

/** Guides visible for a selected filter (everyone + role). */
export function guidesForFilter(filter: HowToAudience): HowToGuide[] {
  if (filter === "everyone") {
    return HOWTO_GUIDES.filter((g) => g.roles.includes("everyone"));
  }
  return HOWTO_GUIDES.filter(
    (g) => g.roles.includes(filter) || g.roles.includes("everyone")
  );
}

/** Default filter from logged-in role. */
export function defaultHowToFilter(role: Role | undefined): HowToAudience {
  if (!role) return "everyone";
  if (role === "viewer") return "viewer";
  return role;
}
