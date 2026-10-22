class ProcessingError(Exception):
    """An expected, user-reportable failure from a processing stage (translation, speech, audio).

    `user_message` must be safe to show to users: no secrets, stack traces or raw
    provider responses.
    """

    def __init__(self, code: str, user_message: str) -> None:
        super().__init__(user_message)
        self.code = code
        self.user_message = user_message
