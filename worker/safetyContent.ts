/**
 * Company safety library. Inserts a topic once, by library_key.
 * Later edits in Manage are left alone: this never rewrites title or body.
 * Job assignment is filled once, when audiences is still empty.
 */

import { audiencesForKey, forNewHireFlag } from "../src/safetyAssign";

export type SafetyLibraryItem = {
  library_key: string;
  category: string;
  for_new_hire: 0 | 1;
  sort_order: number;
  title: string;
  body: string;
};

const SHOWN =
  "Total Assurance shows you this before a normal job turns bad because someone got comfortable and skipped a step. Your stamp is the record that you read it and will follow it on the job.";

export const SAFETY_LIBRARY: SafetyLibraryItem[] = [
  {
    library_key: "nh-stop",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 10,
    title: "Stop when it feels wrong",
    body: `${SHOWN}

If the setup feels wrong, stop. A call you are trying to finish fast is how people get hurt.

You do not have to finish a job that is unsafe. Call the office or your lead, say what you are looking at, and wait for a plan. Leaving a job unfinished is the right call when the alternative is an injury.

Stop and call when you see any of these:
- The ladder shifts, the roof is wet, or you cannot see where your next step lands.
- The panel, the wiring, or the control is something you do not understand.
- You smell gas, or you see scorch marks.
- The customer is pushing you to skip a step.
- A dog is loose, a child is in the work area, or the attic is already too hot to think straight.

Make it safe or leave it. Then call. Do not talk yourself into "it will only take a minute."`,
  },
  {
    library_key: "nh-body",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 20,
    title: "Heat, lifting, and your body",
    body: `${SHOWN}

Attics, roofs, and closed garages can put you down before you notice. Drink water before you climb. Take the shade break while you can still think clearly.

Stop and get out of the heat if you have a headache, nausea, cramps, confusion, a pounding heart, or you stop sweating. Get to the truck with the A/C on, drink water, and call the office. Do not finish the last part of the job.

A coworker who is slurring, confused, or will not come down cannot make that decision. You call for them.

Lift with your legs. A condenser, a furnace, or a compressor is a two-person lift. Ask for help before you slide a unit off the truck alone. A twisted back from "I can get it" is one of the injuries that takes someone off the truck for weeks.

If the attic can be moved to a cooler part of the day, say so before you climb in.`,
  },
  {
    library_key: "nh-ladders",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 30,
    title: "Ladders and roofs",
    body: `${SHOWN}

Set the ladder on firm, level ground. Both feet down. Both rails against something solid. The base sits out about one foot for every four feet of height.

Keep three points of contact on the way up and the way down. Carry tools on a second trip, or pull them up with a line. A heavy bag in one hand is how people come off a ladder.

When you step onto a roof, the ladder needs to reach at least three feet past that step-off. A ladder that is too short does not get a bucket or a truck bed under it to "make it reach." Get a longer ladder.

Stay off a roof that is wet, icy, steep, or soft. Wind and rain are a reason to reschedule. Do not step on a skylight, rotten decking, or the edge. If you cannot see the surface, do not put your weight on it.

Climb down. Do not jump from a roof, a deck, or the top of a ladder.`,
  },
  {
    library_key: "nh-power",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 40,
    title: "Power and capacitors",
    body: `${SHOWN}

Treat every unit as live until you prove it is off. Pull the disconnect and confirm with your meter. A handle can fail. A breaker can be labeled wrong.

Capacitors hold a charge after the power is off. Discharge the capacitor the way you were shown, then confirm zero volts with your meter before your hands go on the terminals. Do this even on a unit you just killed. A charged capacitor can throw you off a ladder or a roof.

Wet ground, wet hands, and a metal ladder do not mix with an open panel. Dry the handle and your hands, or wait.

Tell the customer the power is off, which rooms will be dark, and that they must not reset the breaker or the disconnect while you are in the equipment.

If the wiring is burned, doubled up, or you cannot identify the breaker, stop and call. Metal jewelry comes off before you open a panel.`,
  },
  {
    library_key: "nh-refrigerant",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 50,
    title: "Refrigerant, flame, and gas",
    body: `${SHOWN}

Recover refrigerant into an approved cylinder. Venting it to save ten minutes is not how we do a job.

Before you light a torch, look at what the flame can reach: wood, insulation, filters, paper, and wiring. Use a wet rag or a heat block. Flow nitrogen while you braze. Keep a fire extinguisher within reach, where you are working.

Stay after the flame is out. Feel for hot spots. Attic insulation can smolder after you think you are done. If something catches, kill the torch, put it out if you can do that safely, get people out, and call the fire department and the office.

If you smell gas, stop. Do not flip a switch, light a torch, or use a phone light in the gas. Get the customer outside. Call the gas company and the office from outside. Do not go back in to hunt for a valve if you are lightheaded.

A damaged recovery cylinder, or one that will not take the charge, comes back to the shop. Do not force it.`,
  },
  {
    library_key: "nh-driving",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 60,
    title: "Driving the van",
    body: `${SHOWN}

The phone stays down while the van is moving. Set the route before you roll. Pull over and park before you take a call, answer a text, or look up a part.

Before you leave a driveway or the curb: rear doors latched, side door latched, ladders locked in the rack, cargo strapped, nothing loose on the roof. A ladder that shifts is a road hazard. Pull over and fix it.

Walk around the van before you back out. Children and pets are low and hard to see in a driveway. Racks hit awnings and carports. If you are not sure of the clearance, stop and look.

If you are too tired, too sick, dizzy, or the weather is past what the van should be in, the truck stays parked. Call the office. A late arrival is the outcome we want. A wreck is not.

Alcohol and the company van do not go together. If you cannot drive, call. You will not be told to push through.`,
  },
  {
    library_key: "nh-home",
    category: "New hire",
    for_new_hire: 1,
    sort_order: 70,
    title: "Inside the customer's home",
    body: `${SHOWN}

Ask every time: any dogs, and any kids who will be in this room? Have the customer put them up before tools come in the door. A dog behind a door you are about to open is a reason to wait.

Tell the customer before you kill power, and tell them when it is safe to turn it back on. Say which rooms will be dark.

Keep a clear path. Shoe covers and a drop cloth when the house calls for them. Do not leave an open panel, a charged capacitor, a live wire, or a cord across a walkway while you step away. Kids imitate what they see on the floor.

Before you leave:
- Panels and covers are back on.
- The disconnect is in the position you told them.
- No exposed conductor, no open gas valve, gauges off, cylinder valves closed.
- Hoses, cords, old parts, and screws are picked up.

If the system cannot run safely, leave it off. Tell the customer in plain words what is still off, and tell the office before you roll to the next call. Do not leave a unit that can shock someone, leak gas, or drip into a ceiling without saying so.

If the customer will not secure a pet, or they keep resetting power while you are in the equipment, stop the work and call the office.`,
  },
  {
    library_key: "ht-attic",
    category: "Heights",
    for_new_hire: 0,
    sort_order: 110,
    title: "Attic and roof movement",
    body: `${SHOWN}

Walk the joists. Drywall and insulation are not a floor. A foot through a ceiling injures you and floods the room under you with debris.

Know the way back to the ladder before you crawl deep. A phone light dies. People get turned around in a big attic and crawl the wrong direction until they are exhausted.

Move slowly near a roof edge. A sudden reach for a falling tool is how people go off. Set the tool down. Climb down and get it.

If the decking feels soft, stop. Back out the same way you came in and call. Do not test the next board "to see."

Do not jump down from a roof or a high deck. The ladder is the way down, including when you are hot and ready to be done.`,
  },
  {
    library_key: "ht-ladder-setup",
    category: "Heights",
    for_new_hire: 0,
    sort_order: 120,
    title: "Ladder setup people skip",
    body: `${SHOWN}

Look at the ladder before you climb. Bent rails, a loose rung, or a lock that does not seat means that ladder is out of service for the day. Tag it and use another one.

Both rails contact the wall or the gutter. One rail on and one rail off twists you off the ladder when you shift your weight.

Do not set a ladder in front of a door that can open into it. Do not set it on a slope and kick dirt under one foot as the whole plan. Level it, or move it.

Have someone foot the ladder, or tie it off, when the ground is slick or the wind is up. A gutter is not a tie-off point you can trust with your weight.

Overhead power lines get a different setup. If the ladder or your body can reach a service drop, move the ladder. Do not "just be careful" next to the line.`,
  },
  {
    library_key: "el-panels",
    category: "Electrical",
    for_new_hire: 0,
    sort_order: 210,
    title: "Panels, disconnects, and wet weather",
    body: `${SHOWN}

Open a panel only when you can say what you expect to see. Burned insulation, doubled lugs, or a breaker you cannot trace is a stop. Photograph it if you can do that safely, close it back up, and call.

Pull the disconnect and prove the circuit dead with your meter on a known scale. Then lock it, tape it, or stand the door so the customer can see it is off. Tell them not to reset it.

Rain on an outdoor unit: dry the disconnect handle and your hands before you pull it. Standing water and an extension cord do not share the same puddle. A cord with a cut jacket is done. Bring it back and get another.

Work with one hand in a live cabinet when you must be in there at all, so a shock has a harder path across your chest. The better plan is to prove it dead and then use both hands on a dead circuit.

A mislabeled breaker is common in older houses. The label is a hint. The meter is the answer.`,
  },
  {
    library_key: "el-capacitors",
    category: "Electrical",
    for_new_hire: 0,
    sort_order: 220,
    title: "Capacitors hold a charge",
    body: `${SHOWN}

Every capacitor gets discharged and metered before you handle it. That includes a unit you shut off two minutes ago, and a capacitor you just pulled out of a parts bag if the terminals are exposed.

Confirm zero volts on the terminals with your meter. Then your hands go on it.

A bulged, split, or leaking capacitor gets replaced. Do not put it back to "see if it will start."

Carry capacitors so the terminals cannot land on a nut driver or a fitting in your pouch. A short in the pouch burns a hand and can weld a tool.

The old capacitor leaves the house with you, terminals protected, and goes back to the shop. It does not go in the customer's trash where a child can find it.`,
  },
  {
    library_key: "heat-illness",
    category: "Heat and tight spaces",
    for_new_hire: 0,
    sort_order: 310,
    title: "Heat illness signs people ignore",
    body: `${SHOWN}

People talk themselves out of the early signs because the job is almost done. The early signs are the time to stop.

Stop now if you have:
- A headache that showed up in the heat
- Nausea or cramps
- Confusion, irritability, or trouble speaking
- Skin that has stopped sweating in an attic that should have you soaked
- A heart that is pounding while you are only standing there

Get to shade or the truck. A/C on. Water. Call the office and say you are out of the attic. Give them the address.

If a partner has these signs, you make the call. Do not ask them if they want to finish the capacitor first.

Tell the office early when an attic is already dangerous, so the call can move to a cooler hour. Climbing in because the schedule looks full is how this injury happens.`,
  },
  {
    library_key: "heat-crawl",
    category: "Heat and tight spaces",
    for_new_hire: 0,
    sort_order: 320,
    title: "Crawl spaces and tight closets",
    body: `${SHOWN}

Tell someone you are going under the house, and when you expect to be back out. A text to the office or your lead is enough. If you will be under there a long time, they should know to check.

Look before you crawl: standing water, sewage, snakes, open junction boxes, and a gas smell. Flooded or gassy means you come back out and call. You do not push through a crawl that can trap you.

Keep the cord from wrapping around you. Keep the path back to the opening clear of the old equipment and your own tools.

In a closet, the door stays able to open. The furnace door, the ladder, and the old unit do not become a barricade. You need a way out if something pops, smokes, or you feel faint.

If you feel faint in a tight space, back out immediately. Do not sit down in the crawl and wait to see if it passes.`,
  },
  {
    library_key: "rf-recovery",
    category: "Refrigerant and fire",
    for_new_hire: 0,
    sort_order: 410,
    title: "Recover the refrigerant",
    body: `${SHOWN}

Recover into an approved cylinder that is in date and in good shape. Know what is in the system before you add it to a jug that already holds something else. Mixed refrigerant in the wrong cylinder is a pressure problem for the next person who hooks up to it.

Cylinders stay upright while you charge or recover. Valve caps go back on before the cylinder rides in the van. Keep cylinders out of the closed cab in the sun when the job allows a shaded spot in the cargo area.

A cylinder that is damaged, rusted through, out of date, or will not take the charge gets tagged and brought back. Do not heat a cylinder to force the gas in.

Oil or refrigerant on your skin gets washed off. In your eyes: flush with clean water for a long time and call for medical help, then call the office.

Hoses come off with the gauges at zero and the system valves seated. A hose left open in the back of the van is a cylinder you did not mean to empty.`,
  },
  {
    library_key: "rf-brazing",
    category: "Refrigerant and fire",
    for_new_hire: 0,
    sort_order: 420,
    title: "Brazing without starting a fire",
    body: `${SHOWN}

Before the torch lights, clear the area you can reach with the flame and with dripping solder. Pull back insulation. Wet rag or heat block on valves, wood, cabinet liners, and wiring.

Nitrogen flows through the line while you braze. Oil on the joint gets cleaned off before the flame. Oil plus a torch is a fire on the line itself.

The extinguisher is at the attic hatch or next to you on the roof. It is not in the van while you are twenty feet away from the van.

When the joint is done, kill the torch and stay. Put a hand near the surrounding material. Look for smoke, not only flame. Insulation smolders with almost no flame.

If it catches and you cannot put it out in a few seconds, get the people out of the house, call the fire department, and call the office. Do not leave a smolder to check on the next stop.

Close the torch cylinder valves at the end of the day, not only the torch handle.`,
  },
  {
    library_key: "rf-gas",
    category: "Refrigerant and fire",
    for_new_hire: 0,
    sort_order: 430,
    title: "Gas smell: leave and call",
    body: `${SHOWN}

A rotten-egg smell is the signal to stop the visit as a repair and start it as an evacuation.

Do not flip a switch. Do not change the thermostat. Do not pull a disconnect. Do not use a lighter or a torch. Step outside before you use your phone. A spark is a spark.

Get the customer and anyone else in the house outside, upwind if you can tell which way that is. Include kids and pets if you can do that without going back into a strong odor.

Call the gas utility and the office from outside. Give the address. Stay out until the utility says the building is clear.

Do not go back in to "just shut the valve" if the smell is strong or you already feel lightheaded or headachy. Fresh air is the treatment. Tell the office if anyone feels sick.

A pilot and your torch stay off until the building is cleared. The next repair can wait.`,
  },
  {
    library_key: "dv-phone",
    category: "Driving",
    for_new_hire: 0,
    sort_order: 510,
    title: "Phone down, racks locked",
    body: `${SHOWN}

A text from the office can wait until the van is in park. If they need you now, they will call, and you still pull over before you look at the phone.

Program the route and look up the part number in the driveway, with the transmission in park. The habit that causes the wreck is the glance at a text between stops.

Leave-the-curb check, every time:
- Rear doors latched
- Side door latched
- Ladders locked in the rack, both ends
- Cargo strapped so a hard stop does not throw it forward
- Nothing sitting loose on the roof

Overhead clearance is part of driving this van. Awnings, carports, tree limbs, and drive-throughs catch a rack. If you doubt it, stop and look, or take another path.

If a ladder shifts while you are moving, you do not hold it from the window. Park, get out, and lock it down.`,
  },
  {
    library_key: "dv-parked",
    category: "Driving",
    for_new_hire: 0,
    sort_order: 520,
    title: "When the truck stays parked",
    body: `${SHOWN}

Park and call when the road is past the van: ice, water over the road, wind that moves the van, or a route you cannot see.

Park and call when you are past driving: sick, dizzy, angry enough that you are not watching the road, or you did not sleep. You do not drive the crew "real quick" in that condition. The office will move the work.

After a near miss, stop at the next safe place. Walk around the van. Tell the office what happened. The next stop can wait ten minutes. The point of the call is so we hear about the close call before it becomes a crash.

If you cannot legally or safely drive, say that plainly. The answer from the office is a different plan. It is not "try to make it."

The van stays locked when you leave it on a job, with the keys on you. Cylinders and tools in an open van are a theft and a kid with a torch valve.`,
  },
  {
    library_key: "call-pets",
    category: "On the call",
    for_new_hire: 0,
    sort_order: 610,
    title: "Pets, kids, and power that stays off",
    body: `${SHOWN}

Ask at the door, even at a house you have been to before. Dogs get out. Kids are home sick on a day they were not home last time.

The customer secures the pet before you bring tools through the door and before you open a gate, a garage, or a utility room. You wait. A bite that "the dog never does" is still a bite.

Say out loud when power is going off and which rooms go dark. Ask them not to reset the breaker or the disconnect. If someone resets it while you are on the equipment, stop, prove it dead again, and call the office if it happens twice.

An open panel and a capacitor on the floor are not a work zone you walk away from. If you have to step outside, the panel goes back on or a second adult stays with it. Kids will touch what you left.

If the customer refuses to secure a pet or keeps turning power back on, the work stops. Call the office from the driveway and wait for the next step.`,
  },
  {
    library_key: "call-leave",
    category: "On the call",
    for_new_hire: 0,
    sort_order: 620,
    title: "Leave the home safe",
    body: `${SHOWN}

The last five minutes of the call are part of the repair. This is the list before you start the van:

- Panels, covers, and the furnace door are back on and held by their screws.
- The disconnect is in the position you told the customer, and you said that position out loud.
- No bare conductor is left for the next person, including you on the return trip.
- Gas valves you opened are in the position the equipment needs, or you left them off and said so.
- Gauge hoses are off. Nitrogen and refrigerant cylinder valves are closed and capped.
- Cords, hoses, screws, and the old part are out of the walkway.

If the system cannot run safely, it stays off. You tell the customer in plain words: what is off, why, and that the office knows. Then you tell the office before the next stop. A note in the job is part of telling the office.

Do not leave a unit that can shock someone, leak fuel gas, or drain into a ceiling while you "grab a part and come back," unless the customer has heard exactly what is still unsafe and the office has heard it too.

Your stamp is the record you were shown this leave-the-house list and will use it.`,
  },
  {
    library_key: "wh-stop",
    category: "Warehouse",
    for_new_hire: 0,
    sort_order: 710,
    title: "Stop when the load feels wrong",
    body: `${SHOWN}

The stock room has its own way of getting people hurt: a box that is heavier than it looks, a stack that leans, a truck that starts rolling while you are still in the trailer.

If the load feels wrong, set it down. Ask for a second person or a cart. Call the lead before you climb a rack or ride on a pallet.

Stop and call when you see any of these:
- A stack leans, a pallet is broken, or the wrap is the only thing holding the load.
- You cannot see your feet or the end of the cart.
- A truck is moving, or the driver is still in the cab while you are behind it.
- A chemical container is open, unlabeled, or leaking.
- The aisle is blocked and someone wants you to squeeze past with a load.

Leave the load where it is safe and tell the lead. Finishing the put-away can wait.`,
  },
  {
    library_key: "wh-lift",
    category: "Warehouse",
    for_new_hire: 0,
    sort_order: 720,
    title: "Lifting, carts, and your back",
    body: `${SHOWN}

Lift with your legs. Keep the box against your body. Turn your feet. A twist while you are holding a condenser, a furnace, or a case of parts is how backs go out in this building.

Use a cart or a hand truck for anything you would not want to carry across the lot. Strap the load. A tall stack on a cart that you cannot see over does not go down the aisle.

Two people for a condenser, a furnace, a compressor, or any box you cannot hold with a straight back. Ask before you try it alone.

Carts stay at a walk. Hands stay on the handles, off the pinch point where the frame folds. Park the cart out of the doorway when you stop to pick.

If your back already hurts, say so before the next lift. The lead can change who carries what. Working through a strain is how a one-day ache becomes a month off the floor.`,
  },
  {
    library_key: "wh-dock",
    category: "Warehouse",
    for_new_hire: 0,
    sort_order: 730,
    title: "Trucks, the dock, and the yard",
    body: `${SHOWN}

Stay out of the path of a truck that is backing. The driver cannot see you behind the van or the box truck. Make eye contact before you walk behind a vehicle, and wait until it is off and the brake is set.

Chock the wheels or confirm the brake before you go into a trailer or unload off a liftgate. A trailer that creeps while you are inside it is a crush.

The liftgate is a floor only when it is level and you are standing in the middle of it with a load you can control. Do not ride a liftgate that is moving. Do not jump off it.

Yard speed is a walk when people are around the trucks. Ladders on racks stick out. Look up before you walk between vans.

If a delivery driver will not wait, or the setup on the dock feels wrong, stop the unload and get the lead. The freight can sit.`,
  },
  {
    library_key: "wh-aisle",
    category: "Warehouse",
    for_new_hire: 0,
    sort_order: 740,
    title: "Aisles, stacks, and walkways",
    body: `${SHOWN}

Aisles stay open enough for a person and a cart to pass without turning sideways. A box in the walkway is a trip, and a trip with a condenser in your hands is an injury and a damaged unit.

Stack on a sound pallet, heaviest on the bottom, and only as high as the stack is stable. If you have to lean it against the rack to make it stay, it is too high or the pallet is wrong. Restack it.

Do not climb a rack, a shelf, or a stack of equipment to reach the top. Use the ladder that belongs to the stock room, set the way you were shown, with someone footing it if the floor is slick.

Shrink wrap, banding, and loose screws get picked up when you cut them. Banding springs. Cut it with the cutter you were shown, and keep your face off the line of the cut.

Customers and office staff do not know which aisle is live. If someone is walking the floor, pause the cart and let them pass. Point them back to the counter if they are in the stock path.`,
  },
  {
    library_key: "wh-blade",
    category: "Warehouse",
    for_new_hire: 0,
    sort_order: 750,
    title: "Knives, strapping, and shelf chemicals",
    body: `${SHOWN}

Cut away from your body and away from anyone standing beside you. A dull blade makes you push harder. Change the blade or turn in the knife. Close it before it goes back in a pocket.

Banding and wrap go in the scrap they belong in, not on the floor. A loop of plastic is a trip. A loose band is a cut when someone else grabs the stack.

Chemicals, solvents, coil cleaner, and refrigerant jugs stay upright, capped, and on the shelf that is marked for them. A leaking jug gets gloves, a wipe, and the lead. Do not set it back on a high shelf and hope the cap holds.

Read the label before you pour or spray anything. If the label is gone, do not guess. Tag it and ask.

Wash your hands before you eat. Cleaner on a sandwich is an injury you will not see coming.`,
  },
  {
    library_key: "wh-heat",
    category: "Warehouse",
    for_new_hire: 0,
    sort_order: 760,
    title: "Heat in the warehouse and the yard",
    body: `${SHOWN}

The building and the yard get hot enough to put someone down, especially on a truck that has been closed up in the sun. Drink water before you feel thirsty. Take the shade break while you can still think clearly.

Stop and get into the cool if you have a headache, nausea, cramps, confusion, a pounding heart, or you stop sweating. Tell the lead. Sit down in the office or a cooled truck. Do not finish the trailer first.

A coworker who is confused or will not come in from the yard cannot make that call. You make it for them.

Schedule the heavy unload for the cooler part of the day when the lead can move it. A full trailer in the middle of the afternoon can wait an hour. A person on the concrete cannot.`,
  },
  {
    library_key: "sh-stop",
    category: "Shop",
    for_new_hire: 0,
    sort_order: 810,
    title: "Stop when the bay feels wrong",
    body: `${SHOWN}

The bay is where a shortcut with a jack, a grinder, or a torch turns into the injury we have to explain. If the setup feels wrong, stop and get the lead before you keep going.

Stop when:
- The vehicle is not seated on stands, or the jack is the only thing holding it.
- A fuel line, a battery, or a hot exhaust is in the path of the work.
- You do not know what is under the panel you are about to open.
- Someone is about to start the engine while you are still under the van or in the wheel well.
- The tool, the cord, or the air line is damaged.

Roll the creeper out, set the tool down, and call. The van can stay in the bay. You do not stay under a setup you do not trust.`,
  },
  {
    library_key: "sh-jack",
    category: "Shop",
    for_new_hire: 0,
    sort_order: 820,
    title: "Jacks, stands, and a vehicle in the air",
    body: `${SHOWN}

A jack lifts the van. Jack stands hold it. Never get under a vehicle that is only on a jack. Set the stands at the points the frame can carry, on a solid floor, and give the van a shove test before you roll underneath.

Chock the wheels that stay on the ground. The parking brake is set before the wheels come off. A van that rolls off a stand is a crush injury.

Keep your body out from under the van until the stands are seated. Hands stay clear of the pinch when the axle comes down.

If the stand sinks, the floor is soft, or the van shifts, come out. Reset it. Do not "just grab the bolt" while it is moving.

Lower it the same way you raised it: slow, with the jack, and with everyone clear of the wheels. A wheel that is not torqued does not leave the bay.`,
  },
  {
    library_key: "sh-spark",
    category: "Shop",
    for_new_hire: 0,
    sort_order: 830,
    title: "Grinders, torches, and shop chemicals",
    body: `${SHOWN}

Eyes and face go on before a grinder, a drill, or a torch. The guard stays on the grinder. A disc with a crack, or one that does not match the tool, goes in the trash.

Look at what the sparks can reach: fuel, oil dry that is soaked, cardboard, a battery, an open refrigerant jug. Move it or shield it before you strike an arc or light a torch.

The extinguisher for the bay stays where you can reach it without crossing the fire. Know which one it is before you need it.

Solvents and brake cleaner stay off hot parts and off your skin. Use them with the door open enough to breathe. The rag goes in the can that is for oily rags, with the lid on. A pile of soaked rags on the bench is a fire we start ourselves.

If something catches, kill the tool, put it out if you can do that safely, get people out of the bay, and call the fire department and the office. Do not leave a smolder to check after lunch.`,
  },
  {
    library_key: "sh-hands",
    category: "Shop",
    for_new_hire: 0,
    sort_order: 840,
    title: "Eyes, hands, and pinch points",
    body: `${SHOWN}

Gloves for the cut and the chemical. Glasses for the grind, the hammer, and the battery. A ring or a loose sleeve comes off before your hand goes near a belt, a fan, or a spinning tool.

Batteries get disconnected before you work around the cable. A wrench across the terminals welds itself to the wrench and burns the hand that is holding it.

Fans, belts, and electric fans on a condenser can start when you do not expect it. Confirm the van is off and the key is out, or the battery is disconnected, before your fingers go in.

Compressed air stays off your skin and out of your clothes. Pressure that finds a cut injects air under the skin. That is an emergency room trip, and you call the office on the way.

If you are cut, burned, or you get something in your eye, stop the job and tell the lead the same day. A small cut that gets shop dirt in it is the one that gets infected.`,
  },
  {
    library_key: "sh-cylinders",
    category: "Shop",
    for_new_hire: 0,
    sort_order: 850,
    title: "Fuel, oil, and cylinders in the shop",
    body: `${SHOWN}

Fuel cans, oil, and refrigerant cylinders stay capped and upright. A cylinder rides with the cap on, and it does not stay in a hot closed van longer than the job requires. Bring the damaged or out-of-date cylinder back tagged. Do not force a charge into it.

Drain pans stay under the work until the plug is back in and you have looked twice. Oil on the floor gets cleaned before the next person walks through it. A slip beside a van on stands is a bad fall.

No torch, no grinder, and no smoke near an open fuel tank or a battery you are charging. The gases from a charging battery light.

When you roll a van out, walk around it first. The bay door is fully up. People in the office doorway and parts on the floor are the things you will not see from the driver's seat until it is too late.

Close the torch and the cylinder valves at the end of the day, not only the handle on the torch.`,
  },
  {
    library_key: "of-stop",
    category: "Office",
    for_new_hire: 0,
    sort_order: 910,
    title: "Stop and tell someone",
    body: `${SHOWN}

The office still has injuries: a trip at the counter, a person who collapses in the lobby, a lot that is busier than it looks. If something feels wrong, stop and tell a manager. You do not have to handle a medical emergency or an angry customer alone.

If someone is hurt, dizzy, or cannot speak clearly, call for help and stay with them. Tell the manager the same minute. Do not send them to drive themselves if they are confused or bleeding.

If a customer, a driver, or a vendor is threatening, step back from the counter, get a manager, and lock the door you were shown if that is the plan for the building. You do not have to win the argument.

A spill, a cord across a walkway, or a drawer left open gets fixed when you see it. The next person is the one who falls.`,
  },
  {
    library_key: "of-lot",
    category: "Office",
    for_new_hire: 0,
    sort_order: 920,
    title: "The lot and errand driving",
    body: `${SHOWN}

Vans back up in this lot all day. Walk where a driver can see you. Do not cut behind a van that has its lights on or a driver in the seat. Ladder racks sit higher than you think. Look up when you walk between trucks.

If your job includes an errand in a company vehicle, the phone stays down while it is moving. Pull over to read a text. Doors closed, nothing loose on a seat that can fly forward, and you walk around the vehicle before you back out.

Bad weather, a car that does not feel right, or you being too sick to drive means the errand waits. Call the office. A late bank run is the outcome we want.

Park in a marked spot. Do not leave a vehicle where a truck needs to swing into the dock. Keys stay with you.`,
  },
  {
    library_key: "of-counter",
    category: "Office",
    for_new_hire: 0,
    sort_order: 930,
    title: "The counter, visitors, and slips",
    body: `${SHOWN}

The counter stays clear enough that a visitor can stand at it without a box in the walkway. Parts that are waiting for a tech go on the shelf or the cart, not on the floor in front of the door.

Wet shoes on a hard floor are a fall. Wipe the spot or put the mat down. A cord to a printer or a fan gets taped down or run along the wall.

Visitors, including kids who came with a tech, stay in the office side of the building. The shop, the stock aisles, and the dock are not a shortcut to the restroom. Walk them the way you were shown.

Cabinets and file drawers get closed when you step away. A drawer at shin height is a classic office injury and it is an easy one to prevent.

If a visitor is hurt on the property, help them, tell a manager, and write down what happened the same day: who, what time, and what you saw. That note is part of the file.`,
  },
];

const COLUMN_SQL = [
  "ALTER TABLE safety_topics ADD COLUMN category TEXT",
  "ALTER TABLE safety_topics ADD COLUMN for_new_hire INTEGER",
  "ALTER TABLE safety_topics ADD COLUMN library_key TEXT",
  "ALTER TABLE safety_topics ADD COLUMN audiences TEXT",
  "ALTER TABLE safety_completions ADD COLUMN shown_text TEXT",
];

const LIBRARY_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_safety_topics_library_key ON safety_topics(library_key) WHERE library_key IS NOT NULL";

let safetyLibraryReady = false;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function skipColumnError(msg: string): boolean {
  return /duplicate column name/i.test(msg) || /already exists/i.test(msg);
}

/** Adds category columns and inserts any library topic that is not in the database yet. */
export async function ensureSafetyLibrary(db: D1Database): Promise<void> {
  if (safetyLibraryReady) return;
  for (const sql of COLUMN_SQL) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      const msg = errorText(err);
      if (skipColumnError(msg)) continue;
      throw err;
    }
  }

  const existing = await db
    .prepare(`SELECT id, title, library_key FROM safety_topics`)
    .all<{ id: number; title: string | null; library_key: string | null }>();
  const rows = existing.results || [];
  const byKey = new Set(rows.map((row) => String(row.library_key || "")).filter(Boolean));

  for (const item of SAFETY_LIBRARY) {
    if (byKey.has(item.library_key)) continue;
    const match = rows.find(
      (row) => !row.library_key && String(row.title || "").trim() === item.title
    );
    const audiences = JSON.stringify(audiencesForKey(item.library_key));
    const newHire = forNewHireFlag(audiencesForKey(item.library_key));
    if (match) {
      await db
        .prepare(
          `UPDATE safety_topics
           SET library_key = ?, category = ?, for_new_hire = ?, audiences = ?
           WHERE id = ? AND (library_key IS NULL OR library_key = '')`
        )
        .bind(item.library_key, item.category, newHire, audiences, match.id)
        .run();
      byKey.add(item.library_key);
      continue;
    }
    try {
      await db
        .prepare(
          `INSERT INTO safety_topics (
             title, body, video_url, video_file_key, sort_order, active,
             created_by_user_id, created_at, updated_at, category, for_new_hire, library_key, audiences
           ) VALUES (?, ?, NULL, NULL, ?, 1, NULL, datetime('now'), datetime('now'), ?, ?, ?, ?)`
        )
        .bind(
          item.title,
          item.body,
          item.sort_order,
          item.category,
          newHire,
          item.library_key,
          audiences
        )
        .run();
      byKey.add(item.library_key);
    } catch (err) {
      const msg = errorText(err);
      if (/unique/i.test(msg)) {
        byKey.add(item.library_key);
        continue;
      }
      throw err;
    }
  }

  for (const item of SAFETY_LIBRARY) {
    const audiences = JSON.stringify(audiencesForKey(item.library_key));
    const newHire = forNewHireFlag(audiencesForKey(item.library_key));
    await db
      .prepare(
        `UPDATE safety_topics
         SET audiences = ?, for_new_hire = ?
         WHERE library_key = ? AND (audiences IS NULL OR trim(audiences) = '')`
      )
      .bind(audiences, newHire, item.library_key)
      .run();
  }

  try {
    await db.prepare(LIBRARY_INDEX_SQL).run();
  } catch {
    /* Index is optional. A second insert is still skipped by library_key. */
  }

  safetyLibraryReady = true;
}
