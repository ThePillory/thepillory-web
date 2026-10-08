// The topics that tie the site together: one fixed list, the same for every
// place, official and party. Bills, county agenda items, executive actions and
// Platform excerpts are tagged with up to three each (src/topics/tag.js), and
// campaign-funding industries map to topics by the fixed table below. Pure:
// the Pages Functions import it too. See docs/topics.md.
//
// Slugs are stable (they're in URLs and in topic_tags): never rename or reuse one.

export const TOPICS = [
  { slug: "water", name: "Water", about: "Water supply, rights, storage, rivers and reservoirs, groundwater, drought, and water and sewer service." },
  { slug: "wildfire", name: "Wildfire", about: "Wildfire prevention and response, forest thinning, fire districts, evacuation, and fire insurance." },
  { slug: "roads-transportation", name: "Roads and Transportation", about: "Roads, bridges, highways, transit, aviation, rail, vehicles and traffic." },
  { slug: "housing", name: "Housing", about: "Housing supply and cost, rent, homeownership, homelessness, building and housing programs." },
  { slug: "land-use", name: "Land Use and Planning", about: "Zoning, permits, general plans, development projects, public and federal lands, and parks." },
  { slug: "taxes-budget", name: "Taxes and Budget", about: "Taxes, fees, budgets, appropriations, bonds, debt and how public money is spent." },
  { slug: "schools", name: "Schools and Education", about: "K–12 schools, colleges, student aid, teachers, child care and early education." },
  { slug: "public-safety", name: "Public Safety and Justice", about: "Police, sheriffs, courts, crime, sentencing, jails, emergency services and firearms." },
  { slug: "health", name: "Health", about: "Health care, insurance coverage, hospitals, public health, mental health, drugs and addiction." },
  { slug: "social-services", name: "Social Services", about: "Food and income assistance, aging and disability services, child welfare, and family programs." },
  { slug: "environment", name: "Environment", about: "Air and water quality, climate, wildlife, conservation, waste and pollution." },
  { slug: "energy", name: "Energy and Utilities", about: "Electricity, gas, oil, renewable energy, utility rates and power shutoffs." },
  { slug: "agriculture", name: "Agriculture", about: "Farming, ranching, timber, food production, farm labor and rural programs." },
  { slug: "jobs-economy", name: "Jobs and Economy", about: "Employment, wages, workers, businesses, trade, banking and economic development." },
  { slug: "technology", name: "Broadband and Technology", about: "Internet access, broadband, telecommunications, data, privacy and technology." },
  { slug: "veterans", name: "Veterans", about: "Veterans' benefits, health care, housing and services." },
  { slug: "defense", name: "Defense and Foreign Affairs", about: "The military, national security, foreign relations and international agreements." },
  { slug: "immigration", name: "Immigration", about: "Immigration law, visas, citizenship, asylum and border enforcement." },
  { slug: "government-elections", name: "Government and Elections", about: "Elections and voting, government operations, ethics, transparency, appointments and public records." },
];

export const TOPIC = Object.fromEntries(TOPICS.map((t) => [t.slug, t]));
export const TOPIC_SLUGS = TOPICS.map((t) => t.slug);
export const topicName = (slug) => (TOPIC[slug] ? TOPIC[slug].name : slug);

// Campaign-funding industries (src/funding/industry.js) tied to each topic, by a
// fixed table, the same for everyone. Industries are themselves approximate
// (keyword rules on names), and an industry tied to a topic says nothing about
// what a contribution was for. Industries with no clear subject (lawyers and
// lobbyists, issue groups, leadership PACs, government, media, tribal
// governments, not classified) aren't tied to any topic.
export const INDUSTRY_TOPICS = {
  real_estate: ["housing", "land-use"],
  construction: ["housing", "roads-transportation"],
  health: ["health"],
  pharma: ["health"],
  energy: ["energy"],
  defense: ["defense"],
  agriculture: ["agriculture"],
  transportation: ["roads-transportation"],
  education: ["schools"],
  labor: ["jobs-economy"],
  finance: ["jobs-economy"],
  manufacturing: ["jobs-economy"],
  retail: ["jobs-economy"],
  tech: ["technology"],
};

/** The funding industries tied to a topic (none for most topics). */
export function industriesFor(topic) {
  return Object.entries(INDUSTRY_TOPICS).filter(([, ts]) => ts.includes(topic)).map(([k]) => k);
}
