// `node --test contest/stage/test/director` hands the folder to Node, which loads this file: it pulls in
// every test file of the folder (Node 24 does not recurse into a folder given to --test).
import "./activity.test.mjs";
import "./cli.test.mjs";
import "./host-voice.test.mjs";
import "./live-source.test.mjs";
import "./robustness.test.mjs";
import "./record.test.mjs";
import "./show.test.mjs";
import "./content.test.mjs";
import "./votecast.test.mjs";
import "./queue.test.mjs";
import "./trust.test.mjs";
import "./votewave.test.mjs";
import "./real-logs.test.mjs";
import "./envelopes.test.mjs";
import "./codes.test.mjs";
import "./minute-shots.test.mjs"; // stage-tv
import "./veil.test.mjs";
