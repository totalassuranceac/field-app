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
    summary: "Company policies live here — some versions need your check-off.",
    roles: ["everyone"],
    path: "/handbook",
    steps: [
      "Open Handbook from the menu.",
      "Read the document (scroll or page through the PDF).",
      "When you have finished reading, check the acknowledgment box if it is shown.",
      "Only admin can clear an acknowledgment if a new version must be re-read.",
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
      "Ask for a tool loan for field work. Office approves, then tracks ordered → arrived so you can follow your part. 10% weekly paycheck deduction (min $50/week).",
    roles: ["everyone"],
    path: "/tool-loans",
    steps: [
      "Open Tool Loan Request under Company.",
      "Enter tool/part name, loan amount, and how it helps company field work. Product link is optional but preferred.",
      "Read and check the terms: 10% weekly deduction (minimum $50/week), total open loans ≤ weekly pay, company use only.",
      "Submit — office reviews. You get a notification when approved or declined.",
      "On My requests, watch the progress bar: Requested → Approved → Ordered → Arrived (with dates).",
      "Office/admin: Approvals → Approve/Decline. After approve, Parts to track → Mark ordered, then Mark arrived (optional note for tracking #).",
    ],
    tips: [
      "Loans are only for tools that make Total Assurance field jobs easier — not personal use.",
      "You are notified when office marks Ordered and when the part Arrives.",
      "Office already knows your weekly pay — you do not enter it on the form.",
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
      "Update phone — Live map uses it for Call when someone finds you by name.",
      "Use Change password with your current password, then a new one.",
      "Sign out from the same screen when you leave a shared device.",
    ],
    tips: [
      "Without a phone on file, Call on Live map stays disabled for your unit.",
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
      "Submit and watch Notifications / Home for schedule updates.",
    ],
    tips: [
      "If it is unsafe to drive, say so in the description and contact shop/dispatch by phone too.",
    ],
  },
  {
    id: "field-warranty",
    title: "Drop off a warranty part",
    summary: "Model & serial required · nameplate photo helps · log number on the box.",
    roles: ["driver", "warehouse", "office", "admin"],
    path: "/warranties",
    steps: [
      "Open Warranties (Warehouse menu).",
      "Enter part name. Model # and serial # of the unit the part came off are required.",
      "Optional: photo the unit nameplate — fill the frame with M/N and S/N (avoid metal glare).",
      "Add service address when you can — warehouse uses it later to find who sold the part.",
      "Photo the shelf or bin where you leave the part (required).",
      "Submit — a popup shows the warranty log number (e.g. W0726-001).",
      "Write that number on the box, then tap Got it — take me home.",
    ],
    tips: [
      "Do not skip the number on the box — warehouse matches it to your drop-off photo.",
      "When you fix a wrong model/serial from a nameplate scan, the app learns for next time.",
    ],
  },
  {
    id: "field-parts-receipt",
    title: "Submit a parts purchase receipt",
    summary: "Photo company-card invoices and packing slips instead of turning paper in.",
    roles: ["driver", "mechanic", "warehouse", "office", "admin"],
    path: "/parts-receipts",
    steps: [
      "Open Parts receipts (Warehouse menu).",
      "Choose Vendor pickup (invoice / packing slip #) or Other store (Home Depot, etc.).",
      "For vendor pickups: enter vendor name + invoice or packing slip number.",
      "For other stores: enter the store name; add total/card last 4 if helpful.",
      "Take a clear photo of the full receipt or packing slip.",
      "Check what the scan filled in — fix anything wrong so the app learns.",
      "Save. Office/warehouse can see the submission; no paper turn-in needed.",
    ],
    tips: [
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
    roles: ["everyone", "driver", "office", "warehouse", "mechanic", "admin"],
    path: "/live",
    steps: [
      "Open Live map (Fleet menu).",
      "Type the tech’s name in Find tech by name… (above the map).",
      "When their unit is selected, tap Map for turn-by-turn to their GPS, or Call to dial their phone on file.",
      "You can also tap a row in the vehicle list, then use Map or Call on that row.",
      "Pin popups also offer Map and Call links.",
    ],
    tips: [
      "Call needs a phone on their user or employee record (Settings / People).",
      "Search also works for unit numbers (e.g. 004).",
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
    title: "Part pickup — parts ready at the supply house",
    summary:
      "When a vendor calls (office or tech), put parts on the pickup list so warehouse can pick by vendor before EOD.",
    roles: ["everyone"],
    path: "/part-pickup",
    steps: [
      "Open Part pickup from the menu (or Inventory → Vendor / part-ready list).",
      "Log vendor name, part, qty, needed-for date (usually tomorrow), and job address if known.",
      "Anyone can log it — office after a vendor call, or a tech if the vendor called them.",
      "Tap Stops needed (or a vendor chip) for the Pickup run sheet — big qty × part list by company so you can see if it fits the truck.",
      "Warehouse uses full tickets to mark each line picked / not ready / partial.",
      "If a part is cancelled or no longer needed: open that line → Not needed and type why (required). One part at a time.",
      "Marking picked receives catalog parts into warehouse stock when linked to the catalog.",
    ],
    tips: [
      "Include job address whenever possible — warehouse uses it to find where a warranty part was bought.",
      "Tech handoff from warehouse to truck is Inventory → Pickup (issue + truck scan).",
      "If you already picked up at the vendor and left parts at the shop, use Parts drop-off instead.",
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
      "Use Part pickup when parts are still at the supply house waiting to be collected.",
      "Use Parts drop-off when the parts are already on the counter / in the cage at the shop.",
    ],
  },
  {
    id: "wh-bottles",
    title: "Bottles and company equipment",
    summary: "Check out, return, and swap tanks, ladders, and tagged gear.",
    roles: ["warehouse", "admin", "office"],
    path: "/assets",
    steps: [
      "Open Bottles & gear / Company assets (Warehouse menu).",
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
    summary: "Schedule, update, and close shop work.",
    roles: ["mechanic", "office", "admin"],
    path: "/issues",
    steps: [
      "Open Repairs & shop.",
      "Filter open / scheduled work for your bay or day.",
      "Update status as you diagnose, wait on parts, or finish.",
      "Record what you fixed and parts used when closing.",
      "Use notes so office and the tech know next steps.",
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
      "Use Inventory to browse stock; warehouse changes quantities.",
      "Warranties: search by address or log #; process claim / vendor return statuses.",
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
      "Field: fuel receipts, weekly checks, warranty drop-off, request repair, truck gear, parts receipts, live map Map/Call.",
      "Warehouse: inventory, scan-to-receive, issue-to-tech + truck scan, pickup log, bottles, warranties, log fuel receipts.",
      "Mechanic: shop repairs, oil/service, yard walk, fleet flags, vehicles, weekly checks, log fuel receipts.",
      "Office: live map Map/Call, fuel, scheduled repairs, people, inventory overview, warranties, reports.",
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
