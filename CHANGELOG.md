# Changelog

All notable changes to CyberShuttle Jupyter are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Login keys: SSH Keys, under the account menu, uploads a private key file under a name, lists the stored
  keys with type and fingerprint, and deletes one. The SSH Hosts form picks a stored key as a host's login
  key when adding or editing the host, and a host assigned a key signs in with it. The account menu items
  carry icons.
- Edit an SSH host entry: the paste form now serves both adding and correcting, and an edit opens prefilled with a
  command rebuilt from what is configured, so nothing has to be retyped. The alias is the entry being edited,
  so it is not offered for renaming.
- A walltime countdown on the session card, in the detail dialog, and in the JupyterLab status bar on a
  session's own page, each warning below ten minutes. Every surface ticks on a clock of its own, because a
  settled session is answered `304` and emits no state to re-render from.
- Live CPU, MEM and GPU usage as two or three 3:2 plots in one row, each titled above its own panel and drawn against
  what the job spec asked for rather than against its own maximum. They sit beside the details rather than
  under them, in the same two columns a finished run's report uses, and every live session is read — the run
  history shows the same figures for a session that is still going.
- Run history lists a session that is still going in its live state rather than leaving it out. A run is a
  seq, so the seq a card is on now is a run like any other — it simply has no outcome yet, and
  showing only the finished ones beside it made a previous run read as the live session.
- A run report for a finished session — how long it ran, its peak memory, and how much of the CPU and
  memory its job spec requested it actually used — and a **Run history** dialog listing every run this account
  has finished, including runs whose card has since been deleted.
- The workspace field's help text now names the discovered home directory instead of going blank when
  discovery has not reported one, and explains the `$VAR`, `~` and `/` prefixes a relative path is measured
  against.
- A run report labels Slurm's allocated cores as "Allocated cores", distinct from the "Cores" a session's own
  summary reports for what was requested.
- Testing an SSH host now rejects a reply for a different host, the same way session and Slurm discovery
  reads already do.

### Changed

- A session card's CPU or GPU icon takes the colour of its state pill.
- The Dev Tunnels dialog keeps a box per provider: the linked one becomes a ticked card naming the account
  with Unlink inside it, and the other provider stays offered.
- Add Session starts with `$HOME` as the workspace folder, and its Submit button carries the spinner beside
  "Submitting…" while the request is in flight.
- A stopping session's dialog shows a spinner with "Session <host> is stopping..." in place of the
  access refusal cs-control answers while the job winds down.
- The terminology follows cs-bridge: what you launch is a **session**, described by a job spec. Wire fields
  and routes are renamed to match; see the breaking change below.
- A session's dialog closes from the × in its header, like every other dialog here, rather than from a button
  along the bottom.
- A session's card shows only what it is doing now. Its log appears while it is running and not after, and the
  run report moved to Run history, which keeps every seq rather than only the last.
- A run report carries the log its session produced, so what a session said survives the card it ran on.
- A run report no longer promises accounting that will never arrive. cs-control chases Slurm's accounting for
  ten minutes and then leaves the record alone, so a run older than that says the figures are unknown instead
  of saying they will appear.
- A run report's "Ran for" figure now reads seconds below the hour, like every other countdown here, instead
  of dropping them.
- Stop now asks first. It cancels the Slurm job, which is as destructive as Delete, and was the one verb doing
  it without confirmation.
- Deleting a running session takes one click. cs-control stops first and refuses until the scheduler releases
  the job, so the intent is kept and finished on the poll that sees it released.
- **Breaking:** the wire contract now matches cs-control's own rename. Routes are `/api/v1/sessions`,
  `/api/v1/sessions/validate`, `/api/v1/sessions/history`, `/api/v1/sessions/{id}`,
  `/api/v1/sessions/{id}/start`, `/stop`, `/access` and `/metrics`. The list key is `sessions` and the field
  `runtimeId` is `sessionId` throughout. Ids match `^s-[a-f0-9]{12}$`. Error codes are renamed to match:
  `session_not_found`, `session_owner_mismatch`, `session_exists`, `session_running`, `session_not_stopped`,
  `session_provisioning_in_progress`, `session_access_unavailable`, `session_provisioning_failed`, and
  `invalid_session_id`. This extension now requires a cs-control running the matching `session-lingo`
  contract.
- **Breaking:** a session's and a run's `generation` field is now `seq`, a positive integer starting at 1 and
  incrementing on every start under the same session id, in place of the `g-<16 hex>` string. Session-access
  carries `seq` the same way. The session detail dialog's "Generation" row
  is now "Seq", showing `#<seq>`.
- Every cs-control response shape is now validated with the same `Validator` vocabulary: a shared `vObject`
  rejects any key not in its field list, so an unrecognized field now fails the same way a missing or
  mistyped one already did, instead of passing through silently.
- **Breaking:** sign-in is now CILogon's authorization-code flow with PKCE, finished by cs-control's
  `/oauth/config`, `/oauth/exchange` and `/oauth/refresh` routes, in place of the Microsoft and GitHub
  device-code brokers. Sign in is a single button; there is no provider choice. Every other request carries
  only `Authorization: Bearer <ID token>` and the SSH auth WebSocket offers only `cybershuttle.v1` and
  `bearer.<id token>`; the `X-CyberShuttle-Identity` header and the WebSocket's `identity.`/`github.`
  subprotocols are gone. Sessions run over a Microsoft or GitHub Dev Tunnels account linked once through a
  new **Dev Tunnels** dialog under the account menu, above SSH Keys; cs-control's `409 tunnel_link_required`
  on session create or run-again reopens that dialog and retries the action once linked.

### Fixed

- Session URLs now require sign-in; sign-out returns to the guarded homepage.
- The sessions section is re-mounted when the launcher re-renders its content without it, instead of
  staying gone until another launcher is opened; releasing a section whose node the launcher already
  dropped no longer throws.
- A session list read whose ETag was stored before the body was validated could leave the panel showing an
  empty, silent list until sign-out: a rejected record threw on the first poll, and the next poll's `304`
  then skipped the state update entirely. The ETag is now kept only once the body has parsed and every
  session in it has validated.
- A session log tail with no lines was rejected as invalid, though cs-control never promises a tail is
  non-empty; an empty tail is now accepted.
- Signing out left a connecting or busy session id behind, so an in-flight connect could still report "Sign
  in to CyberShuttle to continue." on the now signed-out panel. Sign out now clears the same state disposal
  does.
- A stop, delete, or run-again on the session this page is attached to never took effect: it read the
  selection before releasing it, so its own current-selection check never matched. A failing stop showed no
  error, and a successful stop or delete left the card as it was; the selection is now captured after the
  release.
- A stop, delete, or run-again in flight when sign-out fired still reported its outcome onto the now
  signed-out panel; the action now checks the same selection sign-out advances that connect already checks.
- A session list, run history, or metrics read already in flight when sign-out fired could still land
  afterward and briefly repopulate a signed-out panel. Each poll now carries the sign-in it started under and
  is discarded once sign-out has moved past it.
- A READY session whose first Jupyter access read answered `session_access_unavailable` kept showing "tunnel
  is not reachable yet" even after a later poll succeeded, because only the failure path touched the panel
  error. The error is now cleared once access is confirmed.
- A session missing its id, seq, or other required fields validated anyway, rendering a card labelled
  "undefined, READY". A session or run's `resources`, an SSH host's optional fields and its `extraDirectives`
  entries and `managed` flag, a session validation's `script` and `message`, a discovered partition's
  `cpuCount`, `memoryMb`, `host`, `accounts` and `gres` entries, and a run's `finalState`, `stats`, `samples`
  and `logs`, are now all required and checked the way every other field already is.
- A `429 rate_limited` response while polling for a device-code token ended sign-in outright, though
  cs-control's `Retry-After` on that response means to keep polling. Polling now honors `Retry-After` and
  continues instead of failing. `Retry-After` is now clamped to 1–60 seconds and never drops the poll
  interval below cs-control's own, so a sub-second or malformed value cannot cause a hot-polling loop.
- The same `429 rate_limited` response to a device authorization start, rather than a poll, ended sign-in
  outright. It now retries once after `Retry-After`, and reports a clear rate-limit message if the retry is
  also refused.
- A metric sample with a non-numeric memory or CPU reading, or GPU utilization, plotted as `NaN`; those
  fields are now required to be numbers when present.
- Retrying a pending delete cleared any unrelated standing error on the card every poll, since it always
  cleared the error before acting; a retry no longer clears an error it did not cause.
- Reading Jupyter access for a session no longer skips the session id check every other session action
  already makes.
- A session that left READY while its Jupyter access was being read reported Connect's generic "Session must
  be READY." instead of what the access read itself failed with. The access failure is now the one reported.
- Test connection, Edit, Delete, and the inline delete confirmation on an SSH host carried no session action
  key, so clicking any of them dropped focus to the page body instead of keeping it on the recreated control.
  Each is now keyed per host.
- Deleting a terminal session's usage samples did not re-render, so its usage plot lingered until something
  else happened to emit state; it now emits immediately.
- Opening a session's detail while Add Session was still open, then closing whichever one closed first,
  left the other with no way to reach its own confirmation dialog; every open detail dialog is now tracked
  and rejected.
- The walltime field on Add Session had no upper bound, though cs-control refuses more than 525600 minutes;
  the field now carries that ceiling and is validated against it the way cores and memory already are.
- The Remaining walltime figure now reads the same in the detail dialog and in run history; run history
  previously appended "left" to the figure while the detail dialog did not.
- Copying the generated Slurm script when the clipboard permission is denied no longer raises an unhandled
  rejection.
- A failed SSH login left the fixed login dock stranded over the shell with no way to dismiss it, since only
  a successful login collapsed it. It now hides on every settled outcome; the caller already reports the
  failure through the panel.
- Discovering a host with no CPU or GPU Slurm partitions threw inside the discovery result handler, leaving
  the query spinner running and every later render broken. The condition now surfaces as an ordinary error.
- A refused relaunch on a session that already carried a startup error, such as a FAILED card, showed that
  stale reason instead of the new refusal.
- Going Back from the Review step of a new session rebuilt the configuration step and reset the chosen
  partition, cores, memory, GPU type, GPU count and Slurm account to their defaults, discarding what was
  picked. Choosing "(no Slurm account)" and going Back re-picked the first account, since the empty choice
  could not be told apart from never having chosen one.
- A delete cs-control refused more than once dropped the intent after the first retry: the id left the
  pending set before the retry's own outcome was known, so a second refusal was never tried again. It now
  leaves the pending set only once the delete succeeds.
- Stop and Delete on the session detail shown inside the still-open Add Session wizard did nothing until the
  wizard was closed by hand: the wizard's dialog was never recorded as the open detail, so the confirmation
  queued behind it instead of reaching it.
- A delete cs-control refused kept its rejection on the card as a standing error for as long as the retry was
  pending, instead of the one click the pending-delete queue promises.
- Stop and Delete rejected the open session detail dialog to raise their own confirmation, and the dialog's
  own × control disposed the same dialog; either one disposed the SSH login dock along with it, since the
  dock was a child of the dialog body. A host that then asked for a login on either action could only report
  the refusal instead of prompting and retrying, unlike Run again. The dock is now attached to the document
  once, on its own, and never owned by the dialog, so it survives either close and a retried login renders in
  it there. The dock shared its floating `.csSshAuth` class with Slurm discovery's in-form progress row,
  which floated the Add Session progress row and login terminal over the shell; the dock now has its own
  class and `.csSshAuth` is inline again. The dock also never hid itself once a login succeeded, leaving
  "Signed in to &lt;host&gt;." on screen as a standing banner; it now hides on success and shows again for the
  next login.
- A pending delete cs-control refused again on a later poll posted that refusal as a standing error, instead
  of staying pending like the first refusal did.
- A live session's usage samples rebuilt the run history's whole node on every poll without keeping focus, so
  an open disclosure lost keyboard focus about once a second.
- A pending delete that needed an SSH login blocked every later poll: the poll awaited the login dock settling
  before it could run again. Retrying a pending delete no longer prompts for a login; it stays pending and is
  tried again on a later poll instead.
- Add Session stayed disabled after adding the first SSH host until the page was reloaded: the panel's own
  host list, which gates the button, was read once at sign-in and never refreshed after the SSH Hosts dialog
  closed. It now re-reads hosts when that dialog closes.
- Alternating between two open Launcher tabs reconnected `title.changed` on the one being returned to, leaking
  one connection per return; each launcher is now wired at most once regardless of how the panel moves
  between them.
- `getSession` did not check the returned session's id against the one requested, unlike start, stop and
  delete; it now rejects a mismatched answer the same way.
- A pending delete's refusal was only classified as retryable while it was still the card the panel was
  showing, so a Connect click on another card while the retry was in flight left it classified as failed and
  dropped from the pending queue outright. Classifying a delete's outcome no longer depends on which card is
  current; only reporting it on screen still does.
- Stopping a READY session and then reading its Jupyter access again on the next poll cleared the stop's error
  the moment the access read succeeded, since the access read cleared the banner unconditionally on success.
  It now clears only the error it reported itself, and leaves an unrelated one standing.
- A session being relaunched showed twice in Run history: the card displays SUBMITTING before cs-control
  responds, but the session underneath is still on its old, already-finished seq, so the same
  seq appeared once as the live card and once as its own finished run. Run history now reads a
  session's real state instead of the display override, so a relaunching card drops out of the running list
  until the new seq arrives.
- An SSH host list read still in flight when sign-out fired could land afterward and populate the next
  account's Add Session dialog with the previous account's hosts; the read is now discarded once sign-out has
  moved past it, the same way session, run and metric reads already are.
- Closing the SSH Hosts dialog after it refreshed cleared a standing stop or delete error on the panel; the
  refresh now clears only the error it reported itself.
- Clicking Connect while a Stop or Delete on the same card was still in flight let that action's completion
  clear Connect's busy state early, re-enabling the card mid-connect; each action's busy state is now released
  only by the call that set it.
- A refused Jupyter access read was retried on every one-second poll forever; it now backs off, doubling up
  to a 30-second cap and resetting on success or once the session's seq changes.
- Run history's finished-run card showed the session's stale terminal state while a run-again was in flight,
  because the display override moved out of the shared session state and into individual views that Run
  history never adopted; it now shows SUBMITTING the same way the session card and detail dialog do.
- The Add SSH Host toggle carried no session action key, so opening the paste form from it dropped focus to
  the page body instead of keeping it on the resulting Cancel button; it is now keyed like every other host
  action.

## [0.1.0] - 2026-09-07

### Added

- Static remote-only JupyterLite site and JupyterLab extension: the file browser, kernels and terminals run
  inside a Slurm allocation, with no in-browser kernel and no local notebook server.
- Launcher **Runtimes** section: submit an allocation, watch its state and startup log, connect to it, stop it
  and delete it.
- Microsoft device-code sign-in brokered by cs-control, with the returned credentials kept in per-tab
  `sessionStorage`.
- SSH host list with add, test and remove, and an xterm.js console for a host's interactive login prompts.
- An action refused because its host wants an interactive login now opens that login and retries once (#7).
- CI over the unit tests and a Chromium end-to-end run of the pipeline (#5), extended to the built `dist/`
  contract (#9).
- Architecture, deployment and contributing documentation, a security policy, issue and pull request
  templates, and the full Apache 2.0 license text in place of the short notice (#12).

### Changed

- **Run again** relaunches the runtime on its own card through cs-control, rather than opening a create form
  seeded from the finished one and producing a second card for the same work (#6).
- A card reads as starting from the click until the relaunch request answers, and follows that answer instead
  of waiting for the next poll (#7).
- The allocation form's floor is 2 cores and 4096 MB, matching what cs-control accepts (#5).
- The panel republishes runtimes only when cs-control reports the list changed (#9).
- The device-code sign-in prompt is a native `<dialog>` (#9).

### Removed

- Browser-side workspace-folder validation, which had drifted from the rules cs-control enforces (#9).

### Fixed

- The runtimes section was missing from every Launcher opened after the first (#6).
- A card being run again re-armed **Run again** a second after the click, and a failed relaunch lost its
  reason to the next poll (#7).
- 23 defects found by an adversarial review, each covered by a regression test (#9).
- The Launcher header and the runtime card category read "Cybershuttle", and the discovery interface read
  "SLURM" (#11).
- A control API or WebSocket URL on the IPv6 loopback host, such as `http://[::1]:8045/api/v1`, was rejected
  as insecure: the accepted loopback hosts held `::1`, while a URL reports that hostname as `[::1]` (#13).

[Unreleased]: https://github.com/cyber-shuttle/cs-jupyter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cyber-shuttle/cs-jupyter/releases/tag/v0.1.0
