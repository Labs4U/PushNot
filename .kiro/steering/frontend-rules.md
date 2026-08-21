---
inclusion: always
---
<!--------------------------------------------------# Project Steering Rules
1. **Tech Stack:** React, TypeScript, Vite, and AWS Amplify Gen 2. 
2. **Strict Scope:** Do not alter `amplify/backend.ts`, `package.json`, or any AWS infrastructure files unless explicitly requested. Focus entirely on the frontend UI layer for this task.
3. **Styling:** Use standard CSS in `App.css`. Do not install or migrate the project to Tailwind, MUI, or Bootstrap. 
4. **Componentization:** Write the layout cleanly inside `App.tsx` for now, but ensure the state management (e.g., active tabs) is abstracted clearly enough that we can break it into separate components later.
5. **No Hallucinated Packages:** Use standard React features. If you need a chart, use dummy HTML/CSS visual placeholders first before suggesting an external library like `recharts`.---------------------------------> 