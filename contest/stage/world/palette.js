// Materials and light temperatures of the Stage. There are no state colours: a state is shown by
// the robot's body, its face light and its console's screen (robots/README.md). Vendor families
// differ by material and shape; the room is a warm near-black lit by its screens and practicals.

// the room (reference 04: #171616 warm near-black, cool screen spill)
export const ROOM = {
  floor: "#1b1a19", floorLine: "#0e0e0e", wall: "#1d1c1b", panel: "#262524", ceiling: "#151413",
  steel: "#8f959c", graphite: "#2a2b2e", laminate: "#2a2826", black: "#0d0d0e", rubber: "#121212",
};

// light sources, as colours of the light (not of things)
export const LIGHT = {
  tungsten: "#ffc994",   // ~2700 K: the pendant over the ballot station
  warm: "#ffd9b0",       // ~3200 K: downlights over the consoles
  screen: "#dbe5ff",     // ~6500 K: a dark-theme monitor's spill
  moon: "#8fa3cc",       // moonlight through the glass
  sodium: "#ffb35e",     // the pit's light towers and road markers
  standby: "#ff9a3c",    // a console's standby LED (offline)
};

// Anthropic: warm glazed ceramic, matte terracotta (references 20, 21, 22)
export const CERAMIC = { cream: "#d8c7ab", porcelain: "#e6dac6", terracotta: "#b0603f", terracottaDeep: "#86432d", clay: "#3a2620", glow: "#ffc68c" };
// OpenAI: black glass with one hard specular band, white light (references 23, 18)
export const GLASS = { black: "#040506", satin: "#101114", smoke: "#0b0c0e", solLight: "#ffc180", astraLight: "#ebecff" };
// the Host: the mine's own machine, neither family
export const HOUSE = { alu: "#a4a9ae", graphite: "#2b2d31", amber: "#d99a3a", lamp: "#fff0dc" };
