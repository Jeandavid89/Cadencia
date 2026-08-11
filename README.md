# Cadencia

SaaS de planning d'employes (cycles A/B, remplacement, lissage, cloture annuelle).

## Environnements (dev / production)

Deux projets Supabase distincts, jamais melanges :

- **Production** : donnees reelles des entreprises clientes. Cle dans `.env.production` (jamais commite).
- **Developpement** : projet Supabase separe, pour travailler sans risque sur la vraie base. Cle dans `.env.development` (jamais commite).

Vite charge automatiquement le bon fichier selon la commande :
- `npm run dev` → mode `development` → lit `.env.development`
- `npm run build` → mode `production` → lit `.env.production`

Aucun autre fichier `.env*` ne doit contenir de cles Supabase (`.env.local` a ete supprime pour cette raison : il primait sur les deux fichiers ci-dessus dans tous les modes et faisait pointer le dev local vers la production).

### Appliquer une evolution de schema

Toujours dans cet ordre :
1. Ecrire le SQL dans un nouveau fichier `supabase/migration_XXX_description.sql`, avec un commentaire d'en-tete explicite.
2. L'executer sur le projet Supabase de **dev** (SQL Editor du dashboard), verifier que tout fonctionne.
3. Reporter les memes changements dans `supabase/schema.sql` (source de verite versionnee).
4. Executer le meme SQL sur le projet **production**, apres validation explicite - jamais en aveugle.
5. Renommer le fichier de migration en suffixant `_APPLIQUE_YYYY-MM-DD` une fois fait sur les deux environnements.

Ne jamais modifier le schema de production sans etre passe par dev d'abord : c'est exactement la derive (colonnes ajoutees a la main, jamais versionnees) qui a motive ce processus.

### Donnees de test

`supabase/seed_dev.sql` cree une entreprise de demonstration (3 employes, un jour ferie, un conge) - a executer uniquement sur le projet de **dev**, apres une premiere inscription via l'app pointee sur `.env.development`.

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
