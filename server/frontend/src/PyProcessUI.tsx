import React, { PropsWithChildren, useCallback, useEffect, useRef, useState } from "react";
import { PyProcess, PyProcessState } from "./PyProcess";
import useWebSocket from "./useWebSocket";
import { parseJsonMessage } from "./Message";

interface PyProcessUIProps {
    pyProcess: PyProcess,
    groupingEnabled: boolean,
    minGroupSize: number,
    msgGroupTimeSeparationInMS: number,
}

type StdOut = {
    type: 'stdout';
    line: string;
    timestamp: number;
}

type StdErr = {
    type: 'stderr';
    line: string;
    timestamp: number;
}

type StdIn = {
    type: 'stdin';
    prompt: string;
    response?: string;
    timestamp: number;
}

type StdIO = StdOut | StdErr | StdIn;

export function PyProcessUI(props: PropsWithChildren<PyProcessUIProps>) {
    const { lastMessage, readyState, sendJsonMessage } = useWebSocket();
    const [pyProcess, setPyProcess] = useState(props.pyProcess);
    const [stdio, setStdIO] = useState<StdIO[]>([]);
    const [stdioGroups, setStdIOGroups] = useState<StdIO[][]>([]);
    const [stdinValue, setStdinValue] = useState<string>("");
    const stdioContainer = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let message = parseJsonMessage(lastMessage);
        if (message) {
            switch (message.type) {
                case 'RUNNING':
                    if (message.data.request_id === pyProcess.requestId) {
                        setPyProcess(prev => {
                            prev.pid = message?.data.pid;
                            prev.state = PyProcessState.RUNNING;
                            return prev;
                        });
                    }
                    break;
                case 'STDOUT':
                    if (!message.data.is_input_prompt) {
                        setStdIO((prev) => prev.concat({ type: 'stdout', line: message?.data.data, timestamp: Date.now() }))
                    } else {
                        setStdIO((prev) => prev.concat({ type: 'stdin', prompt: message?.data.data, timestamp: Date.now() }))
                    }
                    break;
                case 'EXIT':
                    if (message.data.pid === pyProcess.pid) {
                        setPyProcess(prev => {
                            prev.state = PyProcessState.EXITED;
                            return prev;
                        })
                    }
                    break;
            }
        }
    }, [lastMessage, pyProcess]);

    useEffect(() => {
        // This is clean-up only...
        return () => {
            if (pyProcess.state !== PyProcessState.EXITED && pyProcess.pid) {
                sendJsonMessage({ type: "KILL", data: { pid: pyProcess.pid } })
            }
        };
    }, [pyProcess])

    let status: string;
    switch (pyProcess.state) {
        case PyProcessState.STARTING:
            status = 'Starting...';
            break;
        case PyProcessState.RUNNING:
            status = 'Running';
            break;
        case PyProcessState.EXITED:
            status = 'Completed';
            break;
    }

    const handleStdInChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setStdinValue(event.target.value);
    };

    const handleStdInSend = useCallback((lineIndex: number, stdinLine: StdIn) => {
        let message = { "type": "STDIN", "data": { "data": stdinValue, "pid": pyProcess.pid } };
        sendJsonMessage(message);
        setStdIO((prev) => {
            let line = stdio[lineIndex];
            if (line === stdinLine) {
                let copy = [...prev];
                let spliced = copy.splice(lineIndex, 1)[0];
                if (spliced.type === 'stdin') {
                    spliced.response = stdinValue;
                    setStdinValue('');
                    let rv = copy.concat(spliced);
                    return rv;
                } else {
                    throw new Error("Expected stdin... found: " + spliced.type);
                }
            } else {
                throw new Error("Expected line === stdinLine");
            }
        });
    }, [stdinValue]);

    // Auto-scrolling behavior
    useEffect(() => {
        if (stdioContainer.current !== null) {
            stdioContainer.current.scrollTop = stdioContainer.current.scrollHeight;
        }
    }, [stdio]);

    // Group stdio output
    useEffect(() => {
        let stdioGroupings: StdIO[][] = [];

        for (let i = 0; i < stdio.length; i++) {
            let currentMsg = stdio[i];
            let group = [currentMsg];
            if (currentMsg.type === 'stdin' || currentMsg.type === 'stderr') {
                stdioGroupings.push(group);
                continue;
            }

            for (let j = i + 1; j < stdio.length; j++) {
                let nextMsg = stdio[j];
                if (nextMsg.timestamp - currentMsg.timestamp > props.msgGroupTimeSeparationInMS
                    || nextMsg.type === 'stdin'
                    || nextMsg.type === 'stderr') {
                    break;
                }

                group.push(nextMsg);
                currentMsg = nextMsg;
            }

            i += group.length - 1;

            if (group.length >= props.minGroupSize) {
                stdioGroupings.push(group);
            } else {
                stdioGroupings.push(...group.map(el => [el]));
            }
        }

        // When stdio grows rapidly, previous useffect calls can complete after newer ones,
        // so only update groupings if it's based on a newer version of stdio (stdio.length is longer)
        // Can get rid of this with some proper debouncing but it's here for now
        setStdIOGroups(currentGroups => stdio.length > currentGroups.length ? stdioGroupings : currentGroups);
    }, [stdio]);

    function renderLine(line: StdIO, idx: number) {
        switch (line.type) {
            case 'stdin':
                if (line.response === undefined) {
                    return <p key={idx}>{line.prompt}<br />
                        <input onChange={handleStdInChange} onKeyUp={(e) => { if (e.key === 'Enter') { handleStdInSend(idx, line as StdIn); } }} value={stdinValue} autoFocus={true} type="text" className="input input-bordered w-full max-w-xs"></input>
                        <button onClick={() => handleStdInSend(idx, line as StdIn)} className="btn btn-primary ml-4">Send</button>
                    </p>
                } else {
                    return <p key={idx}>{line.prompt}<br />
                        <input autoFocus={true} type="text" className="input input-bordered w-full max-w-xs" value={line.response} disabled={true}></input>
                    </p>
                }
            case 'stdout':
                return <p key={idx}>{line.line}</p>
            default:
                return <></>;
        }
    }

    function renderGroupings() {
        let idx = 0;
        return stdioGroups.map((stdioArr) => {
            return (
                stdioArr.length === 1
                    ?
                    renderLine(stdioArr[0], idx++) // Line is not grouped
                    :
                    <div key={"group-" + idx}>
                        {renderLine(stdioArr[0], idx++)}
                        <details>
                            <summary>
                                [{stdioArr.length - 1}] more lines collapsed
                            </summary>
                            <div>
                                {
                                    stdioArr.slice(1).map((line) => {
                                        return renderLine(line, idx++);
                                    })
                                }
                            </div>
                        </details>
                    </div>
            )
        });
    }

    return <>
        <b>{status}</b>
        <div className="h-[80vh] overflow-y-scroll" ref={stdioContainer}>
            {props.groupingEnabled ? renderGroupings() : stdio.map((line, idx) => renderLine(line, idx))}
        </div>
    </>
}