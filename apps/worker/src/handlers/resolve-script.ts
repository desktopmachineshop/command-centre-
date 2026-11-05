/**
 * The Python script `davinci.render` runs against DaVinci Resolve's scripting API. It is fixed and
 * ships inside the worker: the server only ever sends data (the JSON request below), never code.
 *
 * Protocol: the first line on stdin is the request
 *   {projectName, clips: [absolute paths], preset, fps?, outDir, outputName}
 * and a later `cancel` line (or stdin closing) stops the render. Events go to stdout as JSON lines:
 *   {"type":"progress","progress":0..1,"message":...}
 *   {"type":"done","file":"<name in outDir>"}
 *   {"type":"error","message":...}   (exit 1)
 *   {"type":"cancelled"}             (exit 2)
 * Anything else Resolve prints is ignored by the worker.
 *
 * The script makes a throwaway project per job, then deletes it and reopens whatever project was
 * open before, so the PC's own projects are left as they were.
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
    previous = pm.GetCurrentProject()
    previous_name = previous.GetName() if previous else None
    project = pm.CreateProject(req["projectName"])
    if project is None:
        raise Failed("couldn't create project %s" % req["projectName"])
    job = None
    try:
        if req.get("fps"):
            project.SetSetting("timelineFrameRate", req["fps"])
        pool = project.GetMediaPool()
        emit(type="progress", progress=0.02, message="importing media")
        items = pool.ImportMedia(req["clips"])
        if not items or len(items) != len(req["clips"]):
            raise Failed("imported %d of %d clips" % (len(items or []), len(req["clips"])))
        check()
        timeline = pool.CreateTimelineFromClips("Main", items)
        if timeline is None:
            raise Failed("couldn't build the timeline")

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
        emit(type="done", file=files[0])
    finally:
        try:
            if job:
                project.DeleteRenderJob(job)
            pm.CloseProject(project)
            pm.DeleteProject(req["projectName"])
            if previous_name:
                pm.LoadProject(previous_name)
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
