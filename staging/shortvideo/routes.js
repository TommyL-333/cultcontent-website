// ─── Short Video Agent — routes.js ───────────────────────────────────────────
//
// STATUS: No new server routes are strictly required for the Short Video Agent
// tab. All data access is handled by existing routes in dashboard-server.js:
//
//   GET  /api/arcads/actors          — actor browser
//   GET  /api/arcads/stats           — KPI stats + script performance table
//   GET  /api/arcads/scripts         — folder list for script editor
//   POST /api/arcads/scripts         — create script
//   POST /api/arcads/scripts/:id/generate  — trigger generation
//   GET  /api/arcads/scripts/:id/videos    — poll status
//   POST /api/upload/video           — upload file to queue
//   GET  /api/upload/queue           — fetch staged videos
//   PATCH /api/upload/queue/:id      — update status / upsert Arcads entry
//   DELETE /api/upload/queue/:id     — remove from queue
//   GET  /api/buffer/channels        — Buffer channel list (for posting)
//   POST /api/buffer/post            — post to Buffer channel
//
// ─── Optional future route (not currently needed) ─────────────────────────────
//
// If you want a dedicated 7-day Buffer schedule panel, add this to
// dashboard-server.js after the existing Buffer routes:
//
// app.get('/api/shortvideo/buffer-schedule', async (req, res) => {
//   try {
//     // Re-use the Buffer GraphQL client (already set up in dashboard-server.js)
//     // to fetch the next 7 days of scheduled posts across all channels.
//     // Filter to video posts where mediaType includes 'video'.
//     const since  = new Date().toISOString();
//     const until  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
//     const query  = `
//       query ScheduledPosts($orgId: String!, $since: DateTime, $until: DateTime) {
//         organization(id: $orgId) {
//           posts(filter: { status: SCHEDULED, since: $since, until: $until }, first: 50) {
//             nodes {
//               id text scheduledAt status
//               channel { id name service }
//               media { url type }
//             }
//           }
//         }
//       }`;
//     const { data } = await bufferClient.post('', {
//       query,
//       variables: { orgId: process.env.BUFFER_ORG_ID, since, until },
//     });
//     const posts = data?.data?.organization?.posts?.nodes || [];
//     res.json({ ok: true, posts });
//   } catch(e) { res.status(500).json({ error: e.response?.data || e.message }); }
// });
//
// ─────────────────────────────────────────────────────────────────────────────
// No changes to dashboard-server.js are required for the initial Short Video
// Agent tab. Add the route above only when you build the Buffer schedule panel.
// ─────────────────────────────────────────────────────────────────────────────
