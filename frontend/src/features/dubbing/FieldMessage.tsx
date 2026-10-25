export function FieldMessage({ message, id }: { message?: string; id?: string }) {
  return message ? (
    <p className="error" id={id}>
      {message}
    </p>
  ) : null;
}
