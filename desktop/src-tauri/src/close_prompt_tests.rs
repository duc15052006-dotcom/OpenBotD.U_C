#[test]
fn close_question_returns_before_answer_and_coalesces_repeated_clicks() {
    use std::sync::{atomic::AtomicBool, mpsc, Arc};
    use std::time::Duration;

    for keep_running in [true, false] {
        let pending = Arc::new(AtomicBool::default());
        let (question, answer) = mpsc::channel();
        let (action, actions) = mpsc::channel();
        let (returned, handler_returned) = mpsc::channel();
        let worker = {
            let pending = Arc::clone(&pending);
            let hidden = action.clone();
            std::thread::spawn(move || {
                request_window_close_with(
                    CloseBehavior::Ask,
                    pending,
                    move || hidden.send("hide").unwrap(),
                    move || action.send("exit").unwrap(),
                    move |callback| question.send(callback).unwrap(),
                );
                returned.send(()).unwrap();
            })
        };

        handler_returned
            .recv_timeout(Duration::from_secs(2))
            .expect("close handler blocked the event loop while waiting for a dialog answer");
        worker.join().unwrap();
        assert!(actions.try_recv().is_err(), "no action before the answer");
        let callback = answer.recv_timeout(Duration::from_secs(2)).unwrap();
        request_window_close_with(
            CloseBehavior::Ask,
            Arc::clone(&pending),
            || panic!("duplicate close hid the window"),
            || panic!("duplicate close requested exit"),
            |_| panic!("duplicate close opened another dialog"),
        );

        callback(keep_running);
        assert_eq!(
            actions.recv_timeout(Duration::from_secs(2)).unwrap(),
            if keep_running { "hide" } else { "exit" },
        );
        assert!(actions.try_recv().is_err(), "only one action per answer");

        // Answering releases the guard, so a later X click can ask again.
        let (question, answer) = mpsc::channel();
        request_window_close_with(
            CloseBehavior::Ask,
            pending,
            || {},
            || {},
            move |callback| question.send(callback).unwrap(),
        );
        answer.recv_timeout(Duration::from_secs(2)).unwrap()(true);
    }
}

#[test]
fn saved_close_choices_do_not_open_a_question() {
    use std::sync::{atomic::AtomicBool, mpsc, Arc};

    for behavior in [CloseBehavior::KeepRunning, CloseBehavior::Exit] {
        let (action, actions) = mpsc::channel();
        let hidden = action.clone();
        request_window_close_with(
            behavior,
            Arc::new(AtomicBool::default()),
            move || hidden.send("hide").unwrap(),
            move || action.send("exit").unwrap(),
            |_| panic!("a saved close choice must not prompt"),
        );
        assert_eq!(
            actions.try_recv().unwrap(),
            if behavior == CloseBehavior::KeepRunning {
                "hide"
            } else {
                "exit"
            },
        );
        assert!(actions.try_recv().is_err());
    }
}
