import { RECIPES, ITEMS, type Recipe } from '../core/items';
import type { Inventory } from './inventory';

/** Pure crafting logic (Gameplay Agent scope). */
export class Crafting {
  static canCraft(inv: Inventory, recipe: Recipe): boolean {
    return recipe.inputs.every((i) => inv.has(i.id, i.count));
  }

  /**
   * Attempt to craft. Consumes inputs and adds output.
   * Returns the crafted item id, or null when inputs are missing.
   */
  static craft(inv: Inventory, recipeId: string): string | null {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return null;
    if (!Crafting.canCraft(inv, recipe)) return null;

    // Consume inputs first: this frees room for the output.
    for (const input of recipe.inputs) {
      inv.remove(input.id, input.count);
    }
    inv.add(recipe.output.id, recipe.output.count);
    return recipe.output.id;
  }

  /** All recipes the player can currently craft. */
  static available(inv: Inventory): Recipe[] {
    return RECIPES.filter((r) => Crafting.canCraft(inv, r));
  }

  static recipeName(id: string): string {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return id;
    return ITEMS[r.output.id].name;
  }

  static recipeCost(id: string): string {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return '';
    return r.inputs.map((i) => `${i.count} ${ITEMS[i.id].name}`).join(', ');
  }
}
