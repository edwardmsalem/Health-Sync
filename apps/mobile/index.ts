import { registerRootComponent } from "expo";
import "./src/sync/background.ts"; // define the background task at launch
import App from "./App.tsx";

registerRootComponent(App);
