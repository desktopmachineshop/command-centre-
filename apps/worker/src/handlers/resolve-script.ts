/**
 * The Python script `davinci.render` runs against DaVinci Resolve's scripting API. It is fixed and
 * ships inside the worker: the server only ever sends data (the JSON request below), never code.
 *
 * Protocol: the first line on stdin is the request
 *   {projectName, deleteIfCreated, timeline, render, clips: [absolute paths], preset, fps?, outDir, outputName}
 * and a later `cancel` line (or stdin closing) stops the job. Events go to stdout as JSON lines:
 *   {"type":"progress","progress":0..1,"message":...}
 *   {"type":"done","file":"<name in outDir>"|null,"project":...|null,"timeline":...,"existing":bool}
 *   {"type":"error","message":...}   (exit 1)
 *   {"type":"cancelled"}             (exit 2)
 * Anything else Resolve prints is ignored by the worker.
 *
 * Projects: `projectName` is opened if it exists (`existing`), otherwise created. The clips are
 * appended to the timeline called `timeline`, which is created if the project has none by that
 * name. Then, unless `render` is false (a draft), it is rendered.
 *  - On success, a project that existed, or one created without `deleteIfCreated`, is saved and
 *    left open for Dave. A throwaway (`deleteIfCreated`) is deleted and the project that was open
 *    before is reopened.
 *  - On failure or cancel, a project this job created is deleted, an existing one is closed
 *    without saving (Resolve's CloseProject doesn't save), and the previous project is reopened,
 *    so a failed job leaves Resolve as it found it.
 */
export const RESOLVE_JOB_PY = String.raw`
import json, os, sys, threading, time

def emit(**ev):
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()

class Failed(Exception):
    pass

class Cancelled(Exception):
    pass

def find_timeline(project, name):
    for i in range(1, (project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        if tl and tl.GetName() == name:
            return tl
    return None

def main():
    req = json.loads(sys.stdin.readline())
    cancelled = threading.Event()

    def watch_stdin():
        for line in sys.stdin:
            if line.strip() == "cancel":
                break
        cancelled.set()  # a cancel line, or the worker went away

    threading.Thread(target=watch_stdin, daemon=True).start()

    def check():
        if cancelled.is_set():
            raise Cancelled()

    try:
        import DaVinciResolveScript as dvr
    except ImportError as e:
        raise Failed("can't import DaVinciResolveScript (%s); check RESOLVE_SCRIPT_API and PYTHONPATH" % e)
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        raise Failed("Resolve isn't running, or external scripting is off "
                     "(Preferences > System > General > External scripting using: Local)")

    pm = resolve.GetProjectManager()
    name = req["projectName"]
    previous = pm.GetCurrentProject()
    previous_name = previous.GetName() if previous else None

    existing = True
    project = previous if previous_name == name else pm.LoadProject(name)
    if project is None:
        existing = False
        project = pm.CreateProject(name)
        if project is None:
            raise Failed("couldn't open or create project %s" % name)
    emit(type="progress", progress=0.01, message=("opened project %s" if existing else "created project %s") % name)

    job = None
    ok = False
    try:
        if req.get("fps") and not existing:
            project.SetSetting("timelineFrameRate", req["fps"])
        pool = project.GetMediaPool()
        timeline = find_timeline(project, req["timeline"])
        if req["clips"]:
            emit(type="progress", progress=0.02, message="importing media")
            items = pool.ImportMedia(req["clips"])
            if not items or len(items) != len(req["clips"]):
                raise Failed("imported %d of %d clips" % (len(items or []), len(req["clips"])))
            check()
            if timeline is None:
                timeline = pool.CreateTimelineFromClips(req["timeline"], items)
                if timeline is None:
                    raise Failed("couldn't create timeline %s" % req["timeline"])
            else:
                project.SetCurrentTimeline(timeline)
                if not pool.AppendToTimeline(items):
                    raise Failed("couldn't add the clips to timeline %s" % req["timeline"])
        elif timeline is None:
            raise Failed("project %s has no timeline called %s" % (name, req["timeline"]))
        project.SetCurrentTimeline(timeline)

        file = None
        if req["render"]:
            if not project.LoadRenderPreset(req["preset"]):
                raise Failed("Resolve has no render preset called %s" % req["preset"])
            os.makedirs(req["outDir"], exist_ok=True)
            project.SetRenderSettings({"SelectAllFrames": True, "TargetDir": req["outDir"], "CustomName": req["outputName"]})
            job = project.AddRenderJob()
            if not job:
                raise Failed("couldn't queue the render")
            if not project.StartRendering(job):
                raise Failed("couldn't start the render")
            emit(type="progress", progress=0.05, message="rendering")
            while project.IsRenderingInProgress():
                if cancelled.is_set():
                    project.StopRendering()
                    raise Cancelled()
                status = project.GetRenderJobStatus(job) or {}
                pct = float(status.get("CompletionPercentage", 0) or 0)
                emit(type="progress", progress=0.05 + 0.95 * pct / 100, message="rendering %d%%" % pct)
                time.sleep(1)
            status = project.GetRenderJobStatus(job) or {}
            if status.get("JobStatus") != "Complete":
                raise Failed("render ended as %s %s" % (status.get("JobStatus"), status.get("Error", "")))
            files = sorted(f for f in os.listdir(req["outDir"]) if f.startswith(req["outputName"]))
            if not files:
                raise Failed("the render finished but wrote no file")
            file = files[0]
        check()
        ok = True
        keep = existing or not req["deleteIfCreated"]
        emit(type="done", file=file, project=name if keep else None, timeline=req["timeline"], existing=existing)
    finally:
        try:
            if job:
                project.DeleteRenderJob(job)
            keep = ok and (existing or not req["deleteIfCreated"])
            if keep:
                pm.SaveProject()  # left open, for Dave
            else:
                pm.CloseProject(project)  # without saving
                if not existing:
                    pm.DeleteProject(name)
                if previous_name and previous_name != name:
                    pm.LoadProject(previous_name)
                elif previous_name == name:
                    pm.LoadProject(name)  # reopen it as it was saved
        except Exception:
            pass

try:
    main()
except Cancelled:
    emit(type="cancelled")
    sys.exit(2)
except Failed as e:
    emit(type="error", message=str(e))
    sys.exit(1)
except Exception as e:
    emit(type="error", message="%s: %s" % (type(e).__name__, e))
    sys.exit(1)
`;
