/** Example asks for the "What to ask for" step, by kind of store. Shared with the admin UI. */
export type AskIdeaGroup = { id: string; label: string; asks: string[] };

export const ASK_IDEAS: AskIdeaGroup[] = [
  {
    id: "coffee",
    label: "Coffee & tea",
    asks: [
      "Show us your morning cup: how do you take it?",
      "Make your go-to drink with it, start to finish.",
      "Where do you drink it? Show us your favourite spot.",
    ],
  },
  {
    id: "food",
    label: "Food & snacks",
    asks: [
      "Show us your first bite, and your honest reaction.",
      "What do you pair it with? Show us your favourite combo.",
      "Show us where it goes with you: desk, hike, road trip.",
    ],
  },
  {
    id: "apparel",
    label: "Clothing & accessories",
    asks: [
      "Show us how you style it, head to toe.",
      "Wear it somewhere real: work, the weekend or a night out.",
      "Unbox it and try it on. First impressions welcome.",
    ],
  },
  {
    id: "beauty",
    label: "Beauty & skincare",
    asks: [
      "Show us where it fits in your routine.",
      "Before and after: show us the difference.",
      "Show us the texture and how you apply it.",
    ],
  },
  {
    id: "pets",
    label: "Pets",
    asks: [
      "Show us your pet trying it for the first time.",
      "Show us their favourite way to use it, and tell us their name.",
      "Catch the reaction: tail wags, zoomies, happy faces.",
    ],
  },
  {
    id: "fitness",
    label: "Fitness & outdoors",
    asks: [
      "Take it on your next run, ride or hike, and show us where you went.",
      "Show us it in action during your workout.",
      "Show us your setup: what you pack and where it goes.",
    ],
  },
  {
    id: "home",
    label: "Home & kitchen",
    asks: [
      "Show us where it lives in your home.",
      "Show us it in action: cooking, cleaning or relaxing.",
      "Show us the before and after.",
    ],
  },
  {
    id: "auto",
    label: "Cars & gear",
    asks: [
      "Show us it on your car, and tell us what you drive.",
      "Show us the install, or the finished result.",
      "Take it on the road and show us where you ended up.",
    ],
  },
];
