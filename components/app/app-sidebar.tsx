"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { NAV_ITEMS } from "./nav-items";

export function AppSidebar({ footer }: { footer: ReactNode }) {
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3 text-sm font-semibold">6ix Buyer OS</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            {/* The pathname is request data: stream it in so dynamic routes can still
                prerender the shell. Until then, the menu renders with no active item. */}
            <Suspense fallback={<NavMenu pathname={null} />}>
              <ActiveNavMenu />
            </Suspense>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>{footer}</SidebarFooter>
    </Sidebar>
  );
}

function ActiveNavMenu() {
  return <NavMenu pathname={usePathname()} />;
}

function NavMenu({ pathname }: { pathname: string | null }) {
  return (
    <SidebarMenu aria-label="Main">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
        <SidebarMenuItem key={href}>
          <SidebarMenuButton
            isActive={pathname !== null && (pathname === href || pathname.startsWith(`${href}/`))}
            render={<Link href={href} />}
          >
            <Icon />
            <span>{label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
