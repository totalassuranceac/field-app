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
      "Your Home screen shows what needs attention for your role.",
      "Tap your name at the bottom of the menu for Settings and sign out.",
      "The bell / inbox icon shows notifications — tap one to jump to the related page.",
    ],
    tips: [
      "Menus are grouped like Command Center: Fleet, Warehouse, Shop, and Company — tap a group to open it.",
      "You only see links for what your role is allowed to do.",
      "If the app feels “stuck offline,” check the yellow banner — work may save and send when signal returns.",
    ],
  },
  {
    id: "notifications",
    title: "Notifications & alerts",
    summary: "Stay on top of repairs, warranties, handbook, and system alerts.",
    roles: ["everyone"],
    path: "/notifications",
    steps: [
      "Open Notifications from the menu (or the inbox icon).",
      "Unread subjects are bold (like Gmail); read ones use regular weight.",
      "Swipe left on an unread alert to mark it read, or tap Mark read / Open.",
      "Tap a notification to open the related screen (handbook, warranty, etc.).",
      "Warranties stay under the Warranties page; mileage/fuel flags under Alerts.",
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
    id: "settings-password",
    title: "Change your password or phone",
    summary: "Keep your login secure and contact info current.",
    roles: ["everyone"],
    path: "/settings",
    steps: [
      "Open Settings (tap your name in the sidebar).",
      "Update phone if asked — it helps for contact and matching employee records.",
      "Use Change password with your current password, then a new one.",
      "Sign out from the same screen when you leave a shared device.",
    ],
  },

  // ——— Field ———
  {
    id: "field-fuel",
    title: "Log fuel after a fill-up",
    summary: "Photo the receipt when you can — the app fills gallons, total, and card digits.",
    roles: ["driver", "office", "admin"],
    path: "/fuel",
    steps: [
      "Open Log fuel from Daily work.",
      "Pick your unit / truck if it is not already selected.",
      "Take a photo of the full receipt (or pick one from gallery).",
      "Confirm gallons, total cost, last 4 of card, and odometer — fix anything the scan missed.",
      "Add a short note if the odometer looks wrong or the pump failed (optional).",
      "Submit. Mileage flags may appear later if miles look off — office/shop will review those.",
    ],
    tips: [
      "Whole receipt in frame works better than a cropped corner.",
      "If you are offline, the log may queue and send when you have signal again.",
    ],
  },
  {
    id: "field-weekly",
    title: "Complete a weekly truck check",
    summary: "Walk the truck checklist so the shop knows the unit is ready.",
    roles: ["driver", "mechanic", "admin"],
    path: "/inspections",
    steps: [
      "Open Weekly checks.",
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
      "Open Request repair (or Repairs).",
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
      "Open Warranties.",
      "Enter part name. Model # and serial # of the unit the part came off are required.",
      "Optional: photo the unit nameplate — the app tries to fill model and serial.",
      "Photo the shelf or bin where you leave the part.",
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
      "Open Parts receipts.",
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
      "Open My truck gear (Assets).",
      "Review items listed for your truck.",
      "Report condition issues (damage, missing pads, etc.) if the form allows.",
      "Need a bottle swap or new ladder? Talk to warehouse — they issue and return assets.",
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
      "Open Inventory from the menu.",
      "Use the tabs: Stock (counts / levels), Pickup (ready for techs), Order / stage as your process uses them.",
      "Search by part name or code; open a part for vendors, min/max, and location stock.",
      "Adjust stock with set or adjust when you receive or issue parts (warehouse/admin).",
      "Office can usually browse; only warehouse/admin should change quantities.",
    ],
    tips: [
      "Truck stock lines come from the pricebook match — do not invent random SKUs on trucks.",
      "Home / overstock sections help prioritize what is short or heavy.",
    ],
  },
  {
    id: "wh-pickup",
    title: "Handle a parts pickup / handoff",
    summary: "Get requested parts ready and mark the handoff.",
    roles: ["warehouse", "admin"],
    path: "/inventory",
    steps: [
      "Open Inventory → Pickup (or the pickup panel on Home).",
      "Open the open pickup request.",
      "Pull and stage the parts; note shortages if something is not available.",
      "Mark ready / complete according to the buttons on the request.",
      "Tech or office sees status updates on their side.",
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
      "Open Part pickup from the menu (or Inventory → Part pickup).",
      "Log vendor name, part, qty, needed-for date (usually tomorrow), and job address if known.",
      "Anyone can log it — office after a vendor call, or a tech if the vendor called them.",
      "Warehouse opens the same list grouped by vendor and checks off each line when picked up.",
      "Marking picked receives catalog parts into warehouse stock when linked to the catalog.",
    ],
    tips: [
      "This list lives in Field App first — ServiceTitan job # is optional free text for now.",
      "Tech handoff from warehouse to truck is still Inventory → Pickup / custody.",
    ],
  },
  {
    id: "wh-bottles",
    title: "Bottles and company equipment",
    summary: "Issue, return, and swap tanks, ladders, and tagged gear.",
    roles: ["warehouse", "admin", "office"],
    path: "/assets",
    steps: [
      "Open Bottles & gear (Assets).",
      "Use bottle summary to see who has what and what needs attention.",
      "Issue an asset to a truck/person, or return it when it comes back.",
      "Use swap for bottle exchanges so counts stay accurate.",
      "Add new assets with tags/serials when new gear is purchased.",
    ],
  },
  {
    id: "wh-warranty-recv",
    title: "Receive a warranty drop-off",
    summary: "Find what techs left and close the loop.",
    roles: ["warehouse", "admin", "office"],
    path: "/warranties",
    steps: [
      "Open Warranties — look at open / pending drop-offs.",
      "Use the photo and location note to find the part on the shelf.",
      "Process the warranty per company process, then update status in the app.",
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
      "Home shows counts that need attention (repairs, warranties, handbook, etc.).",
      "Open Live map to see units that are reporting GPS.",
      "Jump into Scheduled repairs for the repair calendar / list.",
      "Use Inventory in view mode when you need stock visibility without changing counts.",
    ],
  },
  {
    id: "office-people",
    title: "People — employees and logins",
    summary: "Keep the roster and Field App accounts matched.",
    roles: ["office", "admin"],
    path: "/admin",
    steps: [
      "Open People (or Admin → People).",
      "Add everyone as an Employee even before they have a login.",
      "Create a login with a username; leave password blank to get a join link.",
      "Copy the invite link and send it — they set their own password.",
      "Link employee ↔ user if they were created separately; set role (Field, Warehouse, etc.).",
      "Use Invite on an existing user if they need a new join link.",
    ],
    tips: [
      "Match phones in standard format so people are easier to find.",
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
      "Leave password blank → create → copy the join link.",
      "Send link + username. User opens link, types username, sets password, is signed in.",
      "Use Invite on a user row to re-issue a link (clears password until they finish).",
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
      "Field: fuel, weekly checks, warranty drop-off, part pickup request, request repair, truck gear, parts receipts.",
      "Warehouse: inventory stock, scan-to-receive, part pickup handoff, bottles, warranties process, truck stock counts.",
      "Mechanic: shop repairs, oil/service, yard walk, fleet flags, vehicles, weekly check board.",
      "Office: live map, scheduled repairs, people (employees), inventory overview, warranties, reports.",
      "Admin: everything + invite links, role simulator, audit, settings.",
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
      "Point at the part barcode or QR — the app looks up the part code.",
      "Confirm location, set quantity, tap + Receive.",
      "If the code isn’t in the catalog, type it or add the part first.",
    ],
    tips: [
      "Works best in Chrome on Android with a clear barcode; iPhones may open the camera photo fallback.",
      "USB/Bluetooth wedge scanners that type into the search box also work.",
    ],
  },
  {
    id: "warranty-vendor-credit",
    title: "Warranty return to vendor & credit",
    summary: "Return to vendor stays open until Approved or Rejected.",
    roles: ["warehouse", "admin", "office", "mechanic"],
    path: "/warranties",
    steps: [
      "Open warranties stay on Open until credit is decided.",
      "Mark Return to vendor when the part ships back (optional RMA + tracking).",
      "Use Waiting on vendor filter to see only those claims.",
      "When credit arrives: enter Credit $ if known, then Approved or Rejected.",
      "Only Approved / Rejected remove it from the open list.",
    ],
  },
  {
    id: "offline-saves",
    title: "Working with weak or no signal",
    summary: "Saves stay on the phone until they can send.",
    roles: ["everyone", "driver"],
    path: "/",
    steps: [
      "If you see “Saved offline” or “waiting to send”, your work is on this phone — not lost.",
      "Keep using the app; fuel, drop-offs, and other queued saves will send when signal returns.",
      "When online again, the yellow banner shows how many are waiting; tap Retry if stuck.",
      "Don’t clear browser data for the app until the queue is clear.",
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
