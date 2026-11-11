/**
 * The example wall merchants can explore in the admin (/app/demo) and the photos on
 * the overview page. Sample photos from Pexels (see public/demo-wall/CREDITS.md);
 * names and captions are made up and clearly labelled as samples.
 */
export type DemoTheme = "coffee" | "pets" | "outdoors";

export type DemoPost = {
  id: string;
  type: "image";
  src: string;
  width: number;
  height: number;
  caption: string;
  author: string | null;
  message: string | null;
  verified: true;
  products: [];
};

const SIZES: Record<string, [number, number]> = {
  "coffee-1": [800, 534], "coffee-2": [800, 1198], "coffee-3": [800, 1067], "coffee-4": [800, 533], "coffee-5": [800, 533],
  "coffee-6": [800, 1200], "coffee-7": [800, 533], "coffee-8": [800, 1200], "coffee-9": [800, 533],
  "pets-1": [800, 600], "pets-2": [800, 1200], "pets-3": [800, 533], "pets-4": [800, 533], "pets-5": [800, 1200], "pets-6": [800, 1200],
  "pets-7": [800, 1140], "pets-8": [800, 532], "pets-9": [800, 533], "pets-10": [800, 1174], "pets-11": [800, 533],
  "outdoors-1": [800, 533], "outdoors-2": [800, 1200], "outdoors-3": [800, 1200], "outdoors-4": [800, 1200], "outdoors-5": [800, 533],
  "outdoors-6": [800, 1200], "outdoors-7": [800, 1067], "outdoors-8": [800, 1208], "outdoors-9": [800, 533], "outdoors-10": [800, 533],
};

const COUNT: Record<DemoTheme, number> = { coffee: 9, pets: 11, outdoors: 10 };

const NAMES = ["Maya", "Jordan", null, "Priya", "Sam", "Leo", null, "Ava", "Noah", "Zoe", "Eli"];

const NOTES: Record<DemoTheme, string[]> = {
  coffee: [
    "Oat flat white, every single morning.",
    "Finally nailed the latte art!",
    "Weekend ritual with the good beans.",
    "My go-to: iced with a splash of vanilla.",
    "Camping coffee hits different.",
  ],
  pets: [
    "Biscuit hasn't put it down since it arrived.",
    "Officially her favourite spot in the house.",
    "Two thumbs (paws) up from Milo.",
    "Zoomies every time I open the box.",
    "He sleeps on it more than I do.",
  ],
  outdoors: [
    "Took it up 1,200 m and it never budged.",
    "Day three on the trail and still comfy.",
    "Rained all morning, stayed bone dry.",
    "Our favourite loop, 14 km.",
    "Packed light, went far.",
  ],
};

export const DEMO_THEMES: { id: DemoTheme; label: string; heading: string; subtext: string }[] = [
  { id: "coffee", label: "Coffee", heading: "Real people. Real moments.", subtext: "From our community to yours." },
  { id: "pets", label: "Pets", heading: "Loved by real pets", subtext: "Shared by the people who live with them." },
  { id: "outdoors", label: "Outdoors", heading: "Tested on real trails", subtext: "Where our customers take it." },
];

/** Every post of a theme. `base` is where public/demo-wall is served ("" = this app). */
export function demoPosts(theme: DemoTheme, base = ""): DemoPost[] {
  return Array.from({ length: COUNT[theme] }, (_, i) => {
    const file = `${theme}-${i + 1}`;
    const [width, height] = SIZES[file];
    const name = NAMES[i % NAMES.length];
    return {
      id: `demo-${file}`,
      type: "image" as const,
      src: `${base}/demo-wall/${file}.jpg`,
      width,
      height,
      caption: name ? `${name} · Verified buyer` : "Verified buyer",
      author: name,
      message: i % 2 === 0 ? NOTES[theme][(i / 2) % NOTES[theme].length] : null,
      verified: true as const,
      products: [] as [],
    };
  });
}
