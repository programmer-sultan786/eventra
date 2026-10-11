import app from './app.js';
import { port } from './config/env.js';

app.listen(port, () => {
  console.log(`Eventra API listening on port ${port}`);
});

