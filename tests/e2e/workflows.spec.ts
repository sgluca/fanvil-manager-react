import { test, expect } from "@playwright/test";
test("login, persona, RFID, permesso, sync e import non distruttivo", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Nome utente", { exact: true }).fill("demo-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("E2E-synthetic-password-2026");
  await page.getByRole("button", { name: "Accedi alla console" }).click();
  await expect(
    page.getByRole("heading", { name: "Panoramica", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/desktop-dashboard.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Persone", exact: true }).click();
  await page.getByRole("button", { name: "Nuova persona" }).click();
  await page.getByLabel("Nome e cognome").fill("Persona E2E");
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(
    page.getByRole("cell", { name: "Persona E2E", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "Persona E2E" })
    .getByRole("button", { name: "Modifica" })
    .click();
  await page.getByLabel("Note", { exact: true }).fill("Nota E2E");
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(page.getByRole("cell", { name: "Nota E2E" })).toBeVisible();
  await page.getByRole("button", { name: "Credenziali", exact: true }).click();
  await page.getByRole("button", { name: "Nuova credenziale" }).click();
  await page
    .getByLabel("Persona", { exact: true })
    .selectOption({ label: "Persona E2E" });
  await page.getByLabel("Valore", { exact: false }).fill("E2E-CARD-7890");
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(page.getByText("••••7890")).toBeVisible();
  await expect(page.getByText("E2E-CARD-7890")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Gruppi e Permessi", exact: true })
    .click();
  await page.getByRole("button", { name: "Nuovo permesso" }).click();
  await page
    .getByLabel("Persona o gruppo")
    .selectOption({ label: "Persona · Persona E2E" });
  await page
    .getByLabel("Dispositivo / Relay", { exact: true })
    .selectOption({ label: "Cortile e salone / Relay 2" });
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(
    page.getByRole("cell", { name: "Relay 2", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sincronizzazioni", exact: true })
    .click();
  await page.getByRole("button", { name: "Nuova anteprima" }).click();
  await page
    .getByLabel("Dispositivo", { exact: true })
    .selectOption({ label: "Cortile e salone" });
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(page.getByText("Aggiunta / aggiornamento")).toBeVisible();
  await page
    .getByRole("button", { name: "Conferma applicazione demo" })
    .click();
  await page.getByLabel("Confermo questa operazione").check();
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(page.getByText("applied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Dispositivi/ }).click();
  const card = page
    .locator(".inventory-card")
    .filter({ hasText: "Segreteria" });
  await card.getByRole("button", { name: "Importa", exact: true }).click();
  await page.getByLabel("Confermo questa operazione").check();
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Sincronizzazioni", exact: true })
    .click();
  await page.getByRole("button", { name: "Riconcilia", exact: true }).click();
  await page.getByLabel("Confermo la riconciliazione").check();
  await page.getByRole("button", { name: "Salva e conferma" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Persone", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Custode demo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Persona E2E", exact: true }),
  ).toBeVisible();
});
test("layout mobile, navigazione tastiera e gestione due relay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Nome utente", { exact: true }).fill("demo-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("E2E-synthetic-password-2026");
  await page.getByRole("button", { name: "Accedi alla console" }).click();
  await expect(
    page.getByRole("heading", { name: "Panoramica", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/mobile-dashboard.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Apri navigazione" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Dispositivi/ }).click();
  const card = page
    .locator(".inventory-card")
    .filter({ hasText: "Cortile e salone" });
  await expect(card.getByText("1. Relay 1", { exact: true })).toBeVisible();
  await expect(card.getByText("2. Relay 2", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
