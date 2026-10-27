import './style.css';
import { App } from './app/app';

const app = new App(document.getElementById('app')!);
// Handy for debugging and for scripting from the console.
(window as unknown as { app: App }).app = app;
