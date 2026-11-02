// `node --test contest/stage/test/voice` hands the folder to Node, which loads this file: it pulls in every test
// file of the folder (Node 24 does not recurse into a folder given to --test).
// browser.mjs (not a test here) is the check of test/voice.html in a real browser against a real service.
import "./voice.test.mjs";
import "./mux.test.mjs";
