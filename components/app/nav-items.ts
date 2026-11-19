import { BookOpenIcon, FlaskConicalIcon, LibraryIcon, SettingsIcon, TagIcon } from "lucide-react";

export const NAV_ITEMS = [
  { href: "/offers", label: "Offers", icon: TagIcon },
  { href: "/research", label: "Research", icon: FlaskConicalIcon },
  { href: "/library", label: "Library", icon: LibraryIcon },
  { href: "/knowledge", label: "Knowledge", icon: BookOpenIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;
